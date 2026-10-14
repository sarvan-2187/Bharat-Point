/**
 * The admin console's calls. See backend/src/admin/routes.ts and
 * backend/src/staff/routes.ts. The server enforces the admin role and the
 * maker-checker rule; this file only asks and displays.
 */
import { api } from './api';
import type { Role } from './session';

export interface StaffEntry {
  userId: string;
  staffCode: string;
  displayName: string;
  role: Role;
  status: 'ACTIVE' | 'SUSPENDED';
  bankCode: string | null;
  activeDevices: number;
  lastSignInAt: string | null;
  agent: {
    agentId: string;
    locationName: string;
    perTxnLimitMinor: number;
    dailyLimitMinor: number;
    usedTodayMinor: number;
    drawerMinor: number;
    floatMinor: number;
  } | null;
}

export interface Alert {
  kind: string;
  severity: 'HIGH' | 'MEDIUM';
  agentCode: string;
  transactionId: string | null;
  detail: string;
  since: string;
}

export interface Replenishment {
  id: string;
  agentCode: string;
  accountKind: 'CASH_DRAWER' | 'FLOAT';
  amountMinor: number;
  note: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  requestedBy: string;
  requestedByCode: string;
  decidedByCode: string | null;
  createdAt: string;
}

export interface Invite {
  token: string;
  qrDataUrl: string;
  expiresAt: string;
}

export const ALERT_TEXT: Record<string, string> = {
  CASH_NOT_HANDED_OVER: 'Customer debited, no cash confirmed',
  RECONCILIATION_REQUIRED: 'Needs a manual check',
  STUCK: 'Stuck waiting',
  AMOUNT_MISMATCHES: 'Repeated amount mismatches',
  NEGATIVE_DRAWER: 'Drawer below zero: replenish or check',
};

const V1 = '/api/v1/admin';
const post = <T>(path: string, body: unknown = {}) => api<T>(`${V1}${path}`, { method: 'POST', body: JSON.stringify(body) });

export const listStaff = async () => (await api<{ staff: StaffEntry[] }>(`${V1}/staff`)).staff;
export const listAlerts = async () => (await api<{ alerts: Alert[] }>(`${V1}/alerts`)).alerts;
export const listReplenishments = async () => (await api<{ replenishments: Replenishment[] }>(`${V1}/replenishments`)).replenishments;

export const createStaff = (input: { role: Role; staffCode: string; displayName: string; locationName?: string; bankCode?: string }) =>
  post<{ user: { id: string }; invite: Invite }>('/staff', input);
export const newInvite = (userId: string) => post<Invite>(`/staff/${userId}/invites`);
export const suspend = (userId: string) => post(`/staff/${userId}/suspend`);
export const reactivate = (userId: string) => post(`/staff/${userId}/reactivate`);
export const resetDevices = (userId: string) => post(`/staff/${userId}/reset-devices`);

export const setLimits = (agentId: string, perTxnLimitMinor: number, dailyLimitMinor: number) =>
  api(`${V1}/agents/${agentId}/limits`, { method: 'PUT', body: JSON.stringify({ perTxnLimitMinor, dailyLimitMinor }) });
export const requestReplenishment = (agentId: string, accountKind: 'CASH_DRAWER' | 'FLOAT', amountMinor: number) =>
  post<{ id: string }>(`/agents/${agentId}/replenishments`, { accountKind, amountMinor });
export const approveReplenishment = (id: string) => post(`/replenishments/${id}/approve`);
export const rejectReplenishment = (id: string) => post(`/replenishments/${id}/reject`);
