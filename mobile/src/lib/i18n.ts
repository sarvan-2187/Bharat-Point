/**
 * Words for the customer-facing screens (welcome, sign in / sign up, the
 * customer's own transactions, settings) in English, Hindi and Telugu. Staff
 * screens stay in English. The choice is kept on this phone; a signed-in
 * customer's choice is also saved to the server (the IVR call uses it).
 */
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as SecureStore from 'expo-secure-store';

export type Lang = 'en' | 'hi' | 'te';
export const LANGS: { code: Lang; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'hi', name: 'हिन्दी' },
  { code: 'te', name: 'తెలుగు' },
];

const en = {
  welcome_title: 'Welcome to BharatPoint',
  welcome_sub: 'Cash services, close to home.',
  sign_in: 'Sign in',
  sign_up: 'Create account',
  staff_enrol: 'I am BharatPoint staff',
  signup_title: 'Create your account',
  secure_note: 'Your phone is your key. Signing in asks for your fingerprint or screen lock.',
  name: 'Full name',
  phone: 'Mobile number',
  bank: 'Your bank',
  language: 'Language',
  ext: 'Phone extension (demo)',
  ext_hint: 'The confirmation call rings this extension. You can leave it empty.',
  create: 'Create account',
  my_transactions: 'My transactions',
  none: 'No transactions yet.',
  settings: 'Settings',
  appearance: 'Appearance',
  auto: 'Auto',
  light: 'Light',
  dark: 'Dark',
  sign_out: 'Sign out',
  cash_out: 'Cash withdrawal',
  cash_in: 'Cash deposit',
  st_done: 'Completed',
  st_progress: 'In progress',
  st_failed: 'Did not go through',
  st_refunded: 'Money returned',
  hello: 'Hello',
};

export type Key = keyof typeof en;

const hi: Record<Key, string> = {
  welcome_title: 'BharatPoint में आपका स्वागत है',
  welcome_sub: 'नकद सेवाएँ, आपके पास।',
  sign_in: 'साइन इन करें',
  sign_up: 'खाता बनाएँ',
  staff_enrol: 'मैं BharatPoint स्टाफ हूँ',
  signup_title: 'अपना खाता बनाएँ',
  secure_note: 'आपका फ़ोन ही आपकी चाबी है। साइन इन पर फ़िंगरप्रिंट या स्क्रीन लॉक माँगा जाएगा।',
  name: 'पूरा नाम',
  phone: 'मोबाइल नंबर',
  bank: 'आपका बैंक',
  language: 'भाषा',
  ext: 'फ़ोन एक्सटेंशन (डेमो)',
  ext_hint: 'पुष्टि कॉल इसी एक्सटेंशन पर आएगी। खाली छोड़ सकते हैं।',
  create: 'खाता बनाएँ',
  my_transactions: 'मेरे लेन-देन',
  none: 'अभी कोई लेन-देन नहीं।',
  settings: 'सेटिंग्स',
  appearance: 'दिखावट',
  auto: 'ऑटो',
  light: 'लाइट',
  dark: 'डार्क',
  sign_out: 'साइन आउट',
  cash_out: 'नकद निकासी',
  cash_in: 'नकद जमा',
  st_done: 'पूरा हुआ',
  st_progress: 'प्रक्रिया में',
  st_failed: 'पूरा नहीं हुआ',
  st_refunded: 'पैसे वापस हुए',
  hello: 'नमस्ते',
};

const te: Record<Key, string> = {
  welcome_title: 'BharatPoint కి స్వాగతం',
  welcome_sub: 'నగదు సేవలు, మీ దగ్గరే.',
  sign_in: 'సైన్ ఇన్',
  sign_up: 'ఖాతా సృష్టించండి',
  staff_enrol: 'నేను BharatPoint సిబ్బందిని',
  signup_title: 'మీ ఖాతాను సృష్టించండి',
  secure_note: 'మీ ఫోనే మీ తాళం చెవి. సైన్ ఇన్ సమయంలో వేలిముద్ర లేదా స్క్రీన్ లాక్ అడుగుతుంది.',
  name: 'పూర్తి పేరు',
  phone: 'మొబైల్ నంబర్',
  bank: 'మీ బ్యాంక్',
  language: 'భాష',
  ext: 'ఫోన్ ఎక్స్‌టెన్షన్ (డెమో)',
  ext_hint: 'నిర్ధారణ కాల్ ఈ ఎక్స్‌టెన్షన్‌కు వస్తుంది. ఖాళీగా వదలవచ్చు.',
  create: 'ఖాతా సృష్టించండి',
  my_transactions: 'నా లావాదేవీలు',
  none: 'ఇంకా లావాదేవీలు లేవు.',
  settings: 'సెట్టింగ్‌లు',
  appearance: 'రూపం',
  auto: 'ఆటో',
  light: 'లైట్',
  dark: 'డార్క్',
  sign_out: 'సైన్ అవుట్',
  cash_out: 'నగదు ఉపసంహరణ',
  cash_in: 'నగదు జమ',
  st_done: 'పూర్తయింది',
  st_progress: 'ప్రక్రియలో ఉంది',
  st_failed: 'పూర్తి కాలేదు',
  st_refunded: 'డబ్బు తిరిగి వచ్చింది',
  hello: 'నమస్కారం',
};

const WORDS: Record<Lang, Record<Key, string>> = { en, hi, te };

/** A transaction state in words a customer understands. */
export const customerStatus = (state: string): Key => {
  if (state === 'COMPLETED') return 'st_done';
  if (state === 'REVERSED' || state === 'CASH_RETURNED') return 'st_refunded';
  if (['PROVIDER_DECLINED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'SUPERSEDED', 'RECONCILIATION_REQUIRED'].includes(state)) return 'st_failed';
  return 'st_progress';
};

const KEY = 'bp.lang';

interface I18n {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: Key) => string;
}

const I18nContext = createContext<I18n>({ lang: 'en', setLang: () => {}, t: (k) => en[k] });

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>('en');

  useEffect(() => {
    SecureStore.getItemAsync(KEY)
      .then((v) => (v === 'en' || v === 'hi' || v === 'te' ? setLangState(v) : undefined))
      .catch(() => {});
  }, []);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    SecureStore.setItemAsync(KEY, next).catch(() => {});
  }, []);

  const value = useMemo<I18n>(() => ({ lang, setLang, t: (k) => WORDS[lang][k] }), [lang, setLang]);
  return createElement(I18nContext.Provider, { value }, children);
}

export const useI18n = () => useContext(I18nContext);
