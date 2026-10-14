import { useCallback, useState, useMemo, useEffect } from 'react';
import { AccessibilityInfo, ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { Button } from '@/components/button';
import {
  callCustomer,
  cancelTransaction,
  cashNotPaid,
  cashReturned,
  FAILURE_TEXT,
  FINAL_STATES,
  getReceipt,
  getTransaction,
  handOver,
  RECEIPT_STATES,
  rupees,
  signTransaction,
  TXN_LABEL,
  type SignedReceipt,
  type Tx,
} from '@/lib/counter';
import {
  DiditSdk,
  createVerificationSession,
  getVerificationStatus,
  completeMockTransaction,
  type VerificationStatus,
  type MockReceiptData,
} from '@/lib/verification';
import { useTheme, type Colors, size } from '@/lib/theme';

type Tone = 'wait' | 'act' | 'ok' | 'stop';
const toneColors = (colors: Colors): Record<Tone, string> => ({
  wait: colors.border,
  act: colors.accent,
  ok: colors.ok,
  stop: colors.danger,
});

function callText(tx: Tx): string {
  const c = tx.confirmation;
  if (!c) return 'Calling the customer…';
  const left = Math.max(0, Math.round((Date.parse(c.expiresAt) - Date.now()) / 1000));
  const step =
    c.callState === 'IN_PROGRESS'
      ? 'The customer is on the call, keying the amount.'
      : c.callState === 'NO_ANSWER'
        ? 'No answer.'
        : (c.dial ?? 1) > 1
          ? 'Ringing the customer again…'
          : 'Ringing the customer…';
  return `${step} About ${left}s left.`;
}

/** What the agent must know right now, from the server's state. Cash moves only on an "act" with a button. */
function status(tx: Tx): { tone: Tone; title: string; detail?: string } {
  const amount = rupees(tx.amountMinor);
  const why = tx.failureCode ? (FAILURE_TEXT[tx.failureCode] ?? tx.failureCode) : undefined;
  const noCash = tx.txnType === 'CASH_OUT' ? 'Do not hand over cash.' : undefined;
  switch (tx.state) {
    case 'CREATED':
      return tx.agentSigned
        ? { tone: 'act', title: 'Signed. Call customer or complete face verification.' }
        : { tone: 'act', title: 'Not signed yet.', detail: 'Sign on this phone before proceeding.' };
    case 'AWAITING_CUSTOMER':
      return { tone: 'wait', title: 'Waiting for the customer', detail: `${callText(tx)} ${noCash ?? ''}`.trim() };
    case 'CUSTOMER_CONFIRMED':
    case 'PROVIDER_PENDING':
    case 'PROVIDER_APPROVED':
      if (tx.state === 'PROVIDER_APPROVED' && tx.txnType === 'CASH_OUT') {
        return { tone: 'act', title: `Bank approved. Hand ${amount} to ${tx.customerName}.`, detail: 'Then confirm below.' };
      }
      return { tone: 'wait', title: 'Customer confirmed. Waiting for the bank…', detail: noCash };
    case 'UNKNOWN_OUTCOME':
      return { tone: 'wait', title: "The bank's answer was lost. Checking with the bank…", detail: noCash };
    case 'CASH_NOT_DISBURSED':
    case 'REVERSAL_PENDING':
      return { tone: 'wait', title: 'Cash not paid. Refunding the customer at the bank…' };
    case 'CASH_RETURN_REQUIRED':
      return { tone: 'act', title: `The bank declined the deposit. Give ${amount} back to ${tx.customerName}.`, detail: why };
    case 'COMPLETED':
      return { tone: 'ok', title: tx.txnType === 'CASH_OUT' ? `${amount} paid out. Completed.` : `${amount} deposited. Completed.` };
    case 'REVERSED':
      return { tone: 'ok', title: "Refunded. The customer's account is back where it was." };
    case 'CASH_RETURNED':
      return { tone: 'ok', title: 'Cash returned to the customer.' };
    case 'PROVIDER_DECLINED':
      return { tone: 'stop', title: 'The bank declined.', detail: [why, noCash].filter(Boolean).join(' ') };
    case 'REJECTED':
      return { tone: 'stop', title: 'Not confirmed.', detail: [why, noCash].filter(Boolean).join(' ') };
    case 'EXPIRED':
      return { tone: 'stop', title: 'Expired before the customer confirmed.', detail: noCash };
    case 'CANCELLED':
      return { tone: 'stop', title: 'Cancelled.' };
    case 'SUPERSEDED':
      return { tone: 'stop', title: 'Replaced by a newer transaction.' };
    case 'RECONCILIATION_REQUIRED':
      return { tone: 'stop', title: 'Needs a manual check by the bank.', detail: [why, noCash].filter(Boolean).join(' ') };
    default:
      return { tone: 'wait', title: tx.state };
  }
}

export default function TransactionScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { id, autoVerify } = useLocalSearchParams<{ id: string; autoVerify?: string }>();

  const [tx, setTx] = useState<Tx | null>(null);
  const [receipt, setReceipt] = useState<SignedReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Didit Verification State (KYB & KYC)
  const [verificationSessionId, setVerificationSessionId] = useState<string | null>(null);
  const [verificationSessionToken, setVerificationSessionToken] = useState<string | null>(null);
  const [verificationUrl, setVerificationUrl] = useState<string | null>(null);
  const [verificationStatus, setVerificationStatus] = useState<VerificationStatus>('Not Started');
  const [verificationBusy, setVerificationBusy] = useState(false);
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const [mockReceipt, setMockReceipt] = useState<MockReceiptData | null>(null);

  const load = useCallback(async () => {
    try {
      const latest = await getTransaction(id);
      setTx(latest);
      if (RECEIPT_STATES.has(latest.state)) setReceipt(await getReceipt(id));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  // Poll transaction every 2 s while this screen is open and not in a final state
  const final = tx !== null && FINAL_STATES.has(tx.state);
  useFocusEffect(
    useCallback(() => {
      if (final) return;
      load();
      const timer = setInterval(load, 2000);
      return () => clearInterval(timer);
    }, [load, final])
  );

  // Poll Didit verification status when a session is pending
  useFocusEffect(
    useCallback(() => {
      if (!verificationSessionId || verificationStatus !== 'Pending') return;

      const check = async () => {
        try {
          const res = await getVerificationStatus(verificationSessionId, tx?.customerId);
          setVerificationStatus(res.status);
          if (res.status !== 'Pending') {
            setVerificationBusy(false);
          }
        } catch {
          // ignore transient poll error
        }
      };

      check();
      const timer = setInterval(check, 3000);
      return () => clearInterval(timer);
    }, [verificationSessionId, verificationStatus, tx?.customerId])
  );

  // ── Face Verification Actions ─────────────────────────────────────────────

  const startFaceVerification = useCallback(async () => {
    if (!tx) return;
    setVerificationBusy(true);
    setVerificationError(null);
    try {
      const session = await createVerificationSession({
        transactionId: tx.id,
        customerId: tx.customerId,
        amountMinor: tx.amountMinor,
      });

      setVerificationSessionId(session.sessionId);
      setVerificationSessionToken(session.sessionToken ?? null);
      setVerificationUrl(session.verificationUrl);
      setVerificationStatus('Pending');

      // 1. Launch with native DiditSdk using session.sessionToken
      let launchedNative = false;
      if (session.sessionToken) {
        try {
          await DiditSdk.startVerification(session.sessionToken);
          launchedNative = true;
        } catch {
          // Native bridge not linked in standard Expo Go; fallback to hosted browser
        }
      }

      // 2. Fallback to hosted verification URL via WebBrowser if native launch was bypassed
      if (!launchedNative && session.verificationUrl) {
        await WebBrowser.openBrowserAsync(session.verificationUrl);
      }

      // Refresh status upon returning (never assume success on close)
      try {
        const updated = await getVerificationStatus(session.sessionId, tx.customerId);
        setVerificationStatus(updated.status);
      } catch {
        // Keep polling
      }
    } catch (e) {
      setVerificationError((e as Error).message);
    } finally {
      setVerificationBusy(false);
    }
  }, [tx]);

  // Auto-start verification if arrived from new screen with autoVerify=1
  useEffect(() => {
    if (autoVerify === '1' && tx && verificationStatus === 'Not Started' && !verificationBusy) {
      startFaceVerification();
    }
  }, [autoVerify, tx, verificationStatus, verificationBusy, startFaceVerification]);

  async function openVerificationBrowser() {
    if (!tx || !verificationSessionId) return;
    setVerificationBusy(true);
    setVerificationError(null);
    try {
      let launchedNative = false;
      if (verificationSessionToken) {
        try {
          await DiditSdk.startVerification(verificationSessionToken);
          launchedNative = true;
        } catch {
          // fallback
        }
      }
      if (!launchedNative && verificationUrl) {
        await WebBrowser.openBrowserAsync(verificationUrl);
      }
      const updated = await getVerificationStatus(verificationSessionId, tx.customerId);
      setVerificationStatus(updated.status);
    } catch (e) {
      setVerificationError((e as Error).message);
    } finally {
      setVerificationBusy(false);
    }
  }

  async function checkManualStatus() {
    if (!verificationSessionId || !tx) return;
    setVerificationBusy(true);
    setVerificationError(null);
    try {
      const updated = await getVerificationStatus(verificationSessionId, tx.customerId);
      setVerificationStatus(updated.status);
    } catch (e) {
      setVerificationError((e as Error).message);
    } finally {
      setVerificationBusy(false);
    }
  }

  async function completeWithFaceVerification() {
    if (!tx) return;
    setBusy(true);
    setError(null);
    try {
      const res = await completeMockTransaction(tx.id, tx.amountMinor, tx.customerId);
      setMockReceipt(res.receipt);

      // Multilingual voice announcement (Hindi, Telugu, English)
      const amountStr = rupees(tx.amountMinor);
      const announcement = `Transaction completed. ${amountStr} ${tx.txnType === 'CASH_OUT' ? 'paid to' : 'deposited for'} ${tx.customerName}. Identity verified with Didit face verification.`;
      AccessibilityInfo.announceForAccessibility(announcement);

      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function act(action: (tx: Tx) => Promise<unknown>) {
    if (!tx) return;
    setBusy(true);
    setError(null);
    try {
      await action(tx);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      await load();
    }
  }

  if (!tx) {
    return (
      <View style={styles.center}>
        {error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator color={colors.accent} />}
      </View>
    );
  }

  const s = status(tx);
  const isTxCompleted = tx.state === 'COMPLETED' || mockReceipt !== null;

  return (
    <ScrollView contentContainerStyle={styles.page}>
      {/* Transaction Summary Panel */}
      <View style={styles.panel}>
        <Text style={styles.label}>{TXN_LABEL[tx.txnType].toUpperCase()}</Text>
        <Text style={styles.amount}>{rupees(tx.amountMinor)}</Text>
        <Text style={styles.body}>{tx.customerName}</Text>
        <Text style={styles.muted}>{tx.accountLabel}</Text>
      </View>

      {/* State Status Panel */}
      <View style={[styles.panel, { borderColor: toneColors(colors)[s.tone], borderWidth: 2 }]} accessibilityLiveRegion="polite">
        <Text style={[styles.title, { color: s.tone === 'wait' ? colors.text : toneColors(colors)[s.tone] }]}>{s.title}</Text>
        {s.detail ? <Text style={styles.body}>{s.detail}</Text> : null}
        {!final && s.tone === 'wait' && <ActivityIndicator color={colors.accent} />}
      </View>

      {/* ── Didit Face Verification Section ──────────────────────────────── */}
      <View style={styles.verificationCard}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>FACE VERIFICATION</Text>
          <View
            style={[
              styles.statusBadge,
              verificationStatus === 'Approved' && { backgroundColor: colors.ok },
              verificationStatus === 'Pending' && { backgroundColor: colors.accent },
              (verificationStatus === 'Declined' || verificationStatus === 'Expired' || verificationStatus === 'Abandoned') && {
                backgroundColor: colors.danger,
              },
              verificationStatus === 'Not Started' && { backgroundColor: colors.border },
            ]}
          >
            <Text
              style={[
                styles.statusBadgeText,
                verificationStatus === 'Approved' || verificationStatus === 'Declined' || verificationStatus === 'Expired'
                  ? { color: '#FFFFFF' }
                  : { color: colors.bg },
              ]}
            >
              {verificationStatus === 'Approved'
                ? 'VERIFIED'
                : verificationStatus === 'Declined'
                  ? 'FAILED'
                  : verificationStatus.toUpperCase()}
            </Text>
          </View>
        </View>

        {/* Clear customer consent & regulatory notice */}
        <Text style={styles.consentNotice}>
          Consent: Didit face verification verifies identity using camera liveness & face match. (Not Aadhaar / AePS authentication).
        </Text>

        {/* Verification Status Details */}
        {verificationStatus === 'Not Started' && (
          <Text style={styles.muted}>The customer will complete a short, secure liveness verification on this device.</Text>
        )}

        {verificationStatus === 'Pending' && (
          <View style={styles.pendingRow}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.body}>Verification in progress. Awaiting customer completion…</Text>
          </View>
        )}

        {verificationStatus === 'Approved' && (
          <View style={styles.successBox}>
            <Text style={[styles.body, { color: colors.ok, fontWeight: '700' }]}>✓ Customer identity successfully verified</Text>
            <Text style={styles.muted}>Didit face liveness check passed. Authorized for {rupees(tx.amountMinor)}.</Text>
          </View>
        )}

        {(verificationStatus === 'Declined' || verificationStatus === 'Expired' || verificationStatus === 'Abandoned') && (
          <View style={styles.failBox}>
            <Text style={[styles.body, { color: colors.danger, fontWeight: '700' }]}>
              {verificationStatus === 'Expired'
                ? 'Verification session expired. Please retry.'
                : 'Face verification declined. Try again with good lighting.'}
            </Text>
          </View>
        )}

        {/* Action Buttons for Face Verification */}
        {verificationStatus === 'Not Started' && (
          <Button
            label="Verify My Identity"
            disabled={verificationBusy || busy}
            onPress={startFaceVerification}
          />
        )}

        {verificationStatus === 'Pending' && (
          <>
            <Button
              label="Open Verification Window"
              disabled={verificationBusy || !verificationUrl}
              onPress={openVerificationBrowser}
            />
            <Button
              label="Check Status"
              kind="secondary"
              disabled={verificationBusy}
              onPress={checkManualStatus}
            />
          </>
        )}

        {verificationStatus === 'Approved' && !isTxCompleted && (
          <Button
            label={`Complete ${TXN_LABEL[tx.txnType]} (${rupees(tx.amountMinor)})`}
            disabled={busy}
            onPress={completeWithFaceVerification}
          />
        )}

        {(verificationStatus === 'Declined' || verificationStatus === 'Expired' || verificationStatus === 'Abandoned') && (
          <Button
            label="Retry Face Verification"
            kind="secondary"
            disabled={verificationBusy || busy}
            onPress={startFaceVerification}
          />
        )}

        {verificationBusy && <ActivityIndicator color={colors.accent} style={{ marginTop: 8 }} />}
        {verificationError && <Text style={styles.error}>{verificationError}</Text>}
      </View>

      {/* Standard Agent Actions */}
      {tx.state === 'CREATED' && !tx.agentSigned && (
        <Button label="Sign on this phone" disabled={busy} onPress={() => act(signTransaction)} />
      )}
      {tx.state === 'CREATED' && tx.agentSigned && verificationStatus === 'Not Started' && (
        <Button label="Or call the customer (IVR)" kind="secondary" disabled={busy} onPress={() => act((t) => callCustomer(t.id))} />
      )}
      {tx.state === 'PROVIDER_APPROVED' && tx.txnType === 'CASH_OUT' && (
        <>
          <Button label={`I handed over ${rupees(tx.amountMinor)}`} disabled={busy} onPress={() => act(handOver)} />
          <Button label="I could not pay the cash" kind="secondary" danger disabled={busy} onPress={() => act(cashNotPaid)} />
        </>
      )}
      {tx.state === 'CASH_RETURN_REQUIRED' && (
        <Button label={`I gave back ${rupees(tx.amountMinor)}`} disabled={busy} onPress={() => act(cashReturned)} />
      )}
      {(tx.state === 'CREATED' || tx.state === 'AWAITING_CUSTOMER') && (
        <Button
          label="Cancel transaction"
          kind="secondary"
          danger
          disabled={busy}
          onPress={() => act((t) => cancelTransaction(t.id))}
        />
      )}
      {tx.supersededBy && (
        <Button
          label="Open the newer transaction"
          kind="secondary"
          onPress={() => router.replace({ pathname: '/agent/[id]', params: { id: tx.supersededBy! } })}
        />
      )}

      {busy && <ActivityIndicator color={colors.accent} />}
      {error && <Text style={styles.error}>{error}</Text>}

      {/* Mock Face Verification Receipt */}
      {mockReceipt && (
        <View style={[styles.panel, { borderColor: colors.ok, borderWidth: 2 }]}>
          <Text style={[styles.label, { color: colors.ok }]}>MOCK TRANSACTION RECEIPT · DEMO ONLY</Text>
          <Text style={styles.body} selectable>
            {TXN_LABEL[mockReceipt.txnType]} {rupees(mockReceipt.amountMinor)} · COMPLETED
            {'\n'}
            Customer: {mockReceipt.customerName} · {mockReceipt.accountLabel}
            {'\n'}
            Biometrics: Didit Face Verification (Hosted Liveness)
            {'\n'}
            Session: {mockReceipt.verificationSessionId}
            {'\n'}
            Verified: {new Date(mockReceipt.verifiedAt).toLocaleString()}
            {'\n'}
            Issued: {new Date(mockReceipt.issuedAt).toLocaleString()}
          </Text>
          <Text style={styles.muted} selectable>
            Attestation Signature: {mockReceipt.signature.slice(0, 32)}…
          </Text>
        </View>
      )}

      {/* Standard Receipt */}
      {receipt && !mockReceipt && (
        <View style={styles.panel}>
          <Text style={styles.label}>RECEIPT{receipt.receipt.simulated ? ' · DEMO, NOT A REAL TRANSACTION' : ''}</Text>
          <Text style={styles.body} selectable>
            {TXN_LABEL[receipt.receipt.txnType]} {rupees(receipt.receipt.amountMinor)} · {receipt.receipt.state}
            {'\n'}
            {receipt.receipt.customerName} · {receipt.receipt.accountLabel}
            {'\n'}
            Agent {receipt.receipt.agentCode}, {receipt.receipt.agentLocation}
            {'\n'}
            {receipt.receipt.bankCode} ref {receipt.receipt.bankRef ?? '-'}
            {'\n'}
            {new Date(receipt.receipt.issuedAt).toLocaleString()}
          </Text>
          <Text style={styles.muted} selectable>
            Signed (key {receipt.keyId}): {receipt.signature.slice(0, 32)}…
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    page: { padding: size.pad, gap: 12 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: size.pad },
    panel: { backgroundColor: colors.panel, borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: size.pad, gap: 6 },
    label: { color: colors.muted, fontSize: 14, letterSpacing: 2 },
    amount: { color: colors.accent, fontSize: 48, fontWeight: '700' },
    title: { fontSize: size.button, fontWeight: '700' },
    body: { color: colors.text, fontSize: size.body },
    muted: { color: colors.muted, fontSize: 14 },
    error: { color: colors.danger, fontSize: size.body },
    verificationCard: {
      backgroundColor: colors.panel,
      borderColor: colors.accent,
      borderWidth: 1.5,
      borderRadius: size.radius,
      padding: size.pad,
      gap: 10,
    },
    cardHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    cardTitle: {
      color: colors.accent,
      fontSize: 16,
      fontWeight: '700',
      letterSpacing: 1.5,
    },
    statusBadge: {
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    statusBadgeText: {
      fontSize: 12,
      fontWeight: '700',
      letterSpacing: 1,
    },
    consentNotice: {
      color: colors.muted,
      fontSize: 13,
      lineHeight: 18,
      fontStyle: 'italic',
      borderLeftWidth: 2,
      borderLeftColor: colors.accent,
      paddingLeft: 8,
    },
    pendingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginVertical: 4,
    },
    successBox: {
      backgroundColor: colors.bg,
      borderColor: colors.ok,
      borderWidth: 1,
      borderRadius: 8,
      padding: 10,
      gap: 4,
    },
    failBox: {
      backgroundColor: colors.bg,
      borderColor: colors.danger,
      borderWidth: 1,
      borderRadius: 8,
      padding: 10,
      gap: 4,
    },
  });
