/**
 * Words for the customer-facing screens (welcome, sign in / sign up, the
 * customer's own transactions, settings) in English, Hindi, Telugu, Tamil and Malayalam. Staff
 * screens stay in English. The choice is kept on this phone; a signed-in
 * customer's choice is also saved to the server (the IVR call uses it).
 */
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as SecureStore from 'expo-secure-store';

export type Lang = 'en' | 'hi' | 'te' | 'ta' | 'ml';
export const LANGS: { code: Lang; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'hi', name: 'हिन्दी' },
  { code: 'te', name: 'తెలుగు' },
  { code: 'ta', name: 'தமிழ்' },
  { code: 'ml', name: 'മലയാളം' },
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
  pin: 'Choose a 4-digit PIN',
  pin_again: 'Type the PIN again',
  pin_hint: 'The bank will ask for this PIN on the confirmation call. Never tell it to anyone, not even the agent.',
  pin_mismatch: 'The two PINs do not match.',
  pin_weak: 'Choose a harder PIN. Not 1234, 1111 or similar.',
  report: "This wasn't me",
  report_ask: 'Report this transaction? The admin will be told you did not make it.',
  report_yes: 'Report',
  cancel: 'Cancel',
  reported: 'You reported this. The admin has been told.',
  report_tip: 'Never hand your phone to an agent. If someone used it for you, report it here.',
  help: 'Need help?',
  call_support: 'Call support',
  raise_ticket: 'Raise a ticket',
  ticket_prompt: 'Describe your problem',
  send: 'Send',
  ticket_sent: 'Ticket raised. We will get back to you.',
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
  pin: '4 अंकों का PIN चुनें',
  pin_again: 'PIN दोबारा लिखें',
  pin_hint: 'पुष्टि कॉल पर यही PIN पूछा जाएगा। इसे किसी को न बताएँ, एजेंट को भी नहीं।',
  pin_mismatch: 'दोनों PIN एक जैसे नहीं हैं।',
  pin_weak: 'कठिन PIN चुनें। 1234 या 1111 जैसा नहीं।',
  report: 'यह मैंने नहीं किया',
  report_ask: 'इस लेन-देन की शिकायत करें? एडमिन को बताया जाएगा कि यह आपने नहीं किया।',
  report_yes: 'शिकायत करें',
  cancel: 'रद्द करें',
  reported: 'आपने इसकी शिकायत की है। एडमिन को बता दिया गया है।',
  report_tip: 'अपना फ़ोन कभी एजेंट को न दें। अगर किसी ने आपके नाम से किया है, तो यहाँ शिकायत करें।',
  help: 'मदद चाहिए?',
  call_support: 'सहायता को कॉल करें',
  raise_ticket: 'टिकट बनाएँ',
  ticket_prompt: 'अपनी समस्या बताएँ',
  send: 'भेजें',
  ticket_sent: 'टिकट बन गया। हम आपसे संपर्क करेंगे।',
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
  pin: '4 అంకెల PIN ఎంచుకోండి',
  pin_again: 'PIN మళ్లీ టైప్ చేయండి',
  pin_hint: 'నిర్ధారణ కాల్‌లో ఇదే PIN అడుగుతారు. దీన్ని ఎవరికీ చెప్పకండి, ఏజెంట్‌కు కూడా.',
  pin_mismatch: 'రెండు PINలు సరిపోలలేదు.',
  pin_weak: 'కష్టమైన PIN ఎంచుకోండి. 1234 లేదా 1111 వంటివి వద్దు.',
  report: 'ఇది నేను చేయలేదు',
  report_ask: 'ఈ లావాదేవీని నివేదించాలా? ఇది మీరు చేయలేదని అడ్మిన్‌కు తెలియజేయబడుతుంది.',
  report_yes: 'నివేదించండి',
  cancel: 'రద్దు',
  reported: 'మీరు దీన్ని నివేదించారు. అడ్మిన్‌కు తెలియజేయబడింది.',
  report_tip: 'మీ ఫోన్‌ను ఎప్పుడూ ఏజెంట్‌కు ఇవ్వకండి. ఎవరైనా మీ పేరుతో చేస్తే, ఇక్కడ నివేదించండి.',
  help: 'సహాయం కావాలా?',
  call_support: 'సపోర్ట్‌కు కాల్ చేయండి',
  raise_ticket: 'టికెట్ పెట్టండి',
  ticket_prompt: 'మీ సమస్యను వివరించండి',
  send: 'పంపండి',
  ticket_sent: 'టికెట్ నమోదైంది. మేము మిమ్మల్ని సంప్రదిస్తాము.',
};

const ta: Record<Key, string> = {
  welcome_title: 'BharatPoint-க்கு வரவேற்கிறோம்',
  welcome_sub: 'பணச் சேவைகள், உங்கள் அருகிலேயே.',
  sign_in: 'உள்நுழை',
  sign_up: 'கணக்கை உருவாக்கு',
  staff_enrol: 'நான் BharatPoint ஊழியர்',
  signup_title: 'உங்கள் கணக்கை உருவாக்குங்கள்',
  secure_note: 'உங்கள் போன்தான் உங்கள் சாவி. உள்நுழையும்போது கைரேகை அல்லது திரைப் பூட்டு கேட்கப்படும்.',
  name: 'முழுப் பெயர்',
  phone: 'மொபைல் எண்',
  bank: 'உங்கள் வங்கி',
  language: 'மொழி',
  ext: 'போன் நீட்டிப்பு (டெமோ)',
  ext_hint: 'உறுதிப்படுத்தும் அழைப்பு இந்த நீட்டிப்புக்கு வரும். காலியாக விடலாம்.',
  create: 'கணக்கை உருவாக்கு',
  my_transactions: 'என் பரிவர்த்தனைகள்',
  none: 'இன்னும் பரிவர்த்தனைகள் இல்லை.',
  settings: 'அமைப்புகள்',
  appearance: 'தோற்றம்',
  auto: 'தானியங்கி',
  light: 'ஒளி',
  dark: 'இருள்',
  sign_out: 'வெளியேறு',
  cash_out: 'பணம் எடுத்தல்',
  cash_in: 'பணம் செலுத்துதல்',
  st_done: 'முடிந்தது',
  st_progress: 'நடைபெறுகிறது',
  st_failed: 'நடைபெறவில்லை',
  st_refunded: 'பணம் திரும்பியது',
  hello: 'வணக்கம்',
  pin: '4 இலக்க PIN தேர்ந்தெடுக்கவும்',
  pin_again: 'PIN-ஐ மீண்டும் உள்ளிடவும்',
  pin_hint: 'உறுதிப்படுத்தும் அழைப்பில் இந்த PIN கேட்கப்படும். இதை யாரிடமும் சொல்லாதீர்கள், முகவரிடமும் கூட.',
  pin_mismatch: 'இரண்டு PIN-களும் பொருந்தவில்லை.',
  pin_weak: 'கடினமான PIN தேர்ந்தெடுக்கவும். 1234 அல்லது 1111 போன்றவை வேண்டாம்.',
  report: 'இது நான் செய்யவில்லை',
  report_ask: 'இந்தப் பரிவர்த்தனையைப் புகாரளிக்கவா? இதை நீங்கள் செய்யவில்லை என்று நிர்வாகிக்குத் தெரிவிக்கப்படும்.',
  report_yes: 'புகாரளி',
  cancel: 'ரத்து செய்',
  reported: 'நீங்கள் இதைப் புகாரளித்துள்ளீர்கள். நிர்வாகிக்குத் தெரிவிக்கப்பட்டது.',
  report_tip: 'உங்கள் போனை ஒருபோதும் முகவரிடம் கொடுக்காதீர்கள். யாராவது உங்கள் பெயரில் செய்தால், இங்கே புகாரளியுங்கள்.',
  help: 'உதவி வேண்டுமா?',
  call_support: 'ஆதரவை அழைக்கவும்',
  raise_ticket: 'டிக்கெட் எழுப்பவும்',
  ticket_prompt: 'உங்கள் சிக்கலை விவரிக்கவும்',
  send: 'அனுப்பு',
  ticket_sent: 'டிக்கெட் பதிவானது. நாங்கள் தொடர்புகொள்வோம்.',
};

const ml: Record<Key, string> = {
  welcome_title: 'BharatPoint-ലേക്ക് സ്വാഗതം',
  welcome_sub: 'പണ സേവനങ്ങൾ, നിങ്ങളുടെ അടുത്തുതന്നെ.',
  sign_in: 'സൈൻ ഇൻ',
  sign_up: 'അക്കൗണ്ട് ഉണ്ടാക്കുക',
  staff_enrol: 'ഞാൻ BharatPoint ജീവനക്കാരനാണ്',
  signup_title: 'നിങ്ങളുടെ അക്കൗണ്ട് ഉണ്ടാക്കുക',
  secure_note: 'നിങ്ങളുടെ ഫോൺ തന്നെയാണ് നിങ്ങളുടെ താക്കോൽ. സൈൻ ഇൻ ചെയ്യുമ്പോൾ വിരലടയാളമോ സ്ക്രീൻ ലോക്കോ ചോദിക്കും.',
  name: 'മുഴുവൻ പേര്',
  phone: 'മൊബൈൽ നമ്പർ',
  bank: 'നിങ്ങളുടെ ബാങ്ക്',
  language: 'ഭാഷ',
  ext: 'ഫോൺ എക്സ്റ്റൻഷൻ (ഡെമോ)',
  ext_hint: 'സ്ഥിരീകരണ കോൾ ഈ എക്സ്റ്റൻഷനിലേക്ക് വരും. ഒഴിച്ചിടാം.',
  create: 'അക്കൗണ്ട് ഉണ്ടാക്കുക',
  my_transactions: 'എന്റെ ഇടപാടുകൾ',
  none: 'ഇതുവരെ ഇടപാടുകളൊന്നുമില്ല.',
  settings: 'ക്രമീകരണങ്ങൾ',
  appearance: 'രൂപം',
  auto: 'ഓട്ടോ',
  light: 'ലൈറ്റ്',
  dark: 'ഡാർക്ക്',
  sign_out: 'സൈൻ ഔട്ട്',
  cash_out: 'പണം പിൻവലിക്കൽ',
  cash_in: 'പണം നിക്ഷേപിക്കൽ',
  st_done: 'പൂർത്തിയായി',
  st_progress: 'പുരോഗമിക്കുന്നു',
  st_failed: 'പൂർത്തിയായില്ല',
  st_refunded: 'പണം തിരികെ ലഭിച്ചു',
  hello: 'നമസ്കാരം',
  pin: '4 അക്ക PIN തിരഞ്ഞെടുക്കുക',
  pin_again: 'PIN വീണ്ടും നൽകുക',
  pin_hint: 'സ്ഥിരീകരണ കോളിൽ ഈ PIN ചോദിക്കും. ഇത് ആരോടും പറയരുത്, ഏജന്റിനോടും.',
  pin_mismatch: 'രണ്ട് PIN-ഉം പൊരുത്തപ്പെടുന്നില്ല.',
  pin_weak: 'കഠിനമായ PIN തിരഞ്ഞെടുക്കുക. 1234 അല്ലെങ്കിൽ 1111 പോലെ വേണ്ട.',
  report: 'ഇത് ഞാൻ ചെയ്തതല്ല',
  report_ask: 'ഈ ഇടപാട് റിപ്പോർട്ട് ചെയ്യണോ? ഇത് നിങ്ങൾ ചെയ്തതല്ലെന്ന് അഡ്മിനെ അറിയിക്കും.',
  report_yes: 'റിപ്പോർട്ട് ചെയ്യുക',
  cancel: 'റദ്ദാക്കുക',
  reported: 'നിങ്ങൾ ഇത് റിപ്പോർട്ട് ചെയ്തു. അഡ്മിനെ അറിയിച്ചിട്ടുണ്ട്.',
  report_tip: 'നിങ്ങളുടെ ഫോൺ ഒരിക്കലും ഏജന്റിന് കൈമാറരുത്. ആരെങ്കിലും നിങ്ങളുടെ പേരിൽ ചെയ്താൽ ഇവിടെ റിപ്പോർട്ട് ചെയ്യുക.',
  help: 'സഹായം വേണോ?',
  call_support: 'സപ്പോർട്ടിനെ വിളിക്കുക',
  raise_ticket: 'ടിക്കറ്റ് ഉന്നയിക്കുക',
  ticket_prompt: 'നിങ്ങളുടെ പ്രശ്നം വിവരിക്കുക',
  send: 'അയയ്ക്കുക',
  ticket_sent: 'ടിക്കറ്റ് രജിസ്റ്റർ ചെയ്തു. ഞങ്ങൾ ബന്ധപ്പെടും.',
};

const WORDS: Record<Lang, Record<Key, string>> = { en, hi, te, ta, ml };

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
      .then((v) => (v && v in WORDS ? setLangState(v as Lang) : undefined))
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
