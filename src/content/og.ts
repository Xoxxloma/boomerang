import ogs from 'open-graph-scraper';

export interface LinkMeta {
  title?: string;
  description?: string;
  imageUrl?: string;
}

/**
 * Заглушка вместо настоящей меты? Анти-бот сайты (напр. avito.ru жёстко блокирует серверный IP даже
 * под реальным UA) отдают captcha/общую страницу, и open-graph-scraper подбирает её <title>/description
 * как `title === description === "Авито — Объявления на сайте Авито"`. Такую мету НЕ доверяем: она и
 * бесполезный заголовок, и уводит классификацию (Авито → «Недвижимость»). Эвристики (низкий риск ложных):
 *  H1 — title и description совпадают (trim+lower) → почти всегда плейсхолдер;
 *  H2 — title === имя сайта или начинается с «{сайт} — »/«{сайт} - » (boilerplate главной).
 * Легитимная статья без og:title (title из <title>, описание иное/отсутствует) обе проверки не проходит.
 */
export function isPlaceholderMeta(title?: string, description?: string, siteName?: string): boolean {
  const t = title?.trim();
  if (!t) return false;
  const d = description?.trim();
  if (d && t.toLowerCase() === d.toLowerCase()) return true; // H1
  const s = siteName?.trim();
  if (s) {
    const tl = t.toLowerCase();
    const sl = s.toLowerCase();
    if (tl === sl || tl.startsWith(`${sl} — `) || tl.startsWith(`${sl} - `)) return true; // H2
  }
  return false;
}

/** Чистый хост URL (без www) — фолбэк-заголовок для ссылок без вменяемой меты (avito.ru). */
export function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/**
 * Тянем title + Open Graph мету по URL. НЕ читаем тело статьи (§3.1 спеки) — дёшево и быстро.
 * При ошибке возвращаем пустую мету: классификация дальше пойдёт по самому URL.
 * Заглушку анти-бот страниц (isPlaceholderMeta) отбрасываем — иначе мусорный title портит и заголовок,
 * и классификацию. Картинку оставляем (на классификацию не влияет).
 */
export async function fetchLinkMeta(url: string): Promise<LinkMeta> {
  try {
    const { result } = await ogs({
      url,
      fetchOptions: { headers: { 'user-agent': 'Mozilla/5.0 (compatible; BoomerangBot/0.1)' } },
      timeout: 8000,
    });

    const image = Array.isArray(result.ogImage) ? result.ogImage[0]?.url : undefined;
    const title = result.ogTitle ?? result.twitterTitle ?? result.dcTitle;
    const description = result.ogDescription ?? result.twitterDescription ?? result.dcDescription;
    if (isPlaceholderMeta(title, description, result.ogSiteName)) {
      return { imageUrl: image };
    }
    return { title, description, imageUrl: image };
  } catch {
    return {};
  }
}
