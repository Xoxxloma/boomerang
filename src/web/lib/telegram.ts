/**
 * Тонкая обёртка над Telegram WebApp SDK. Даёт initData (подпись для авторизации), тему (light/dark),
 * haptics. В обычном браузере (dev без Telegram) деградирует мягко: тёмная тема, пустой initData
 * (API ответит 401 — это ожидаемо, UI всё равно рендерится на мок-данных).
 */

interface TgThemeParams {
  bg_color?: string;
  secondary_bg_color?: string;
}

interface TgWebApp {
  initData: string;
  colorScheme: 'light' | 'dark';
  themeParams: TgThemeParams;
  ready: () => void;
  expand: () => void;
  /** Отключить родной вертикальный свайп-сворачивание Telegram (Bot API 7.7+) — иначе свайп по
   *  нашим листам сворачивает весь Mini App. Опционально: на старых клиентах метода нет. */
  disableVerticalSwipes?: () => void;
  setHeaderColor: (color: string) => void;
  setBackgroundColor: (color: string) => void;
  onEvent: (event: string, cb: () => void) => void;
  openLink: (url: string) => void;
  HapticFeedback?: {
    impactOccurred: (style: 'light' | 'medium' | 'heavy') => void;
    selectionChanged: () => void;
    notificationOccurred: (type: 'success' | 'warning' | 'error') => void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TgWebApp };
  }
}

const tg: TgWebApp | undefined = window.Telegram?.WebApp;

/**
 * Hex-эквиваленты нашего --bg по теме — Telegram setBackgroundColor не парсит oklch, нужен RGB hex.
 * dark = oklch(0.16 0.025 275) (глубокий индиго), light = чистый белый. Держать в синхроне с tokens.css.
 */
const BG_HEX: Record<'light' | 'dark', `#${string}`> = {
  dark: '#15151d',
  light: '#ffffff',
};

/** Применить тему Telegram к документу: атрибут [data-theme] переключает наш набор токенов. */
function applyTheme(): void {
  const scheme = tg?.colorScheme ?? 'dark';
  document.documentElement.dataset.theme = scheme;
  // Синхронизируем хром Telegram (шапка/фон) с нашим --bg — чтобы рамка приложения не «спорила» с UI.
  if (tg) {
    try {
      tg.setBackgroundColor(BG_HEX[scheme]);
      tg.setHeaderColor(BG_HEX[scheme]);
    } catch {
      /* старые клиенты не поддерживают произвольный цвет — не критично */
    }
  }
}

/** Инициализация при старте: развернуть на весь экран, применить тему, подписаться на смену темы. */
export function initApp(): void {
  if (tg) {
    tg.ready();
    tg.expand();
    // Свайп вниз должен закрывать лист, а не сворачивать апп — забираем жест себе. Полноэкранное
    // приложение и так закрывается через «×». Feature-detect: на клиентах < Bot API 7.7 — no-op.
    tg.disableVerticalSwipes?.();
    tg.onEvent('themeChanged', applyTheme);
  }
  applyTheme();
}

/** Подпись Telegram для авторизации запросов к API. */
export function getInitData(): string {
  return tg?.initData ?? '';
}

/** Открыть внешнюю ссылку через клиент Telegram (а не внутри iframe). */
export function openLink(url: string): void {
  if (tg) tg.openLink(url);
  else window.open(url, '_blank', 'noopener');
}

export function hapticTap(): void {
  tg?.HapticFeedback?.selectionChanged();
}

export function hapticImpact(style: 'light' | 'medium' | 'heavy' = 'light'): void {
  tg?.HapticFeedback?.impactOccurred(style);
}
