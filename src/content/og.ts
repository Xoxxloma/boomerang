import ogs from 'open-graph-scraper';

export interface LinkMeta {
  title?: string;
  description?: string;
  imageUrl?: string;
}

/**
 * Тянем title + Open Graph мету по URL. НЕ читаем тело статьи (§3.1 спеки) — дёшево и быстро.
 * При ошибке возвращаем пустую мету: классификация дальше пойдёт по самому URL.
 */
export async function fetchLinkMeta(url: string): Promise<LinkMeta> {
  try {
    const { result } = await ogs({
      url,
      fetchOptions: { headers: { 'user-agent': 'Mozilla/5.0 (compatible; BoomerangBot/0.1)' } },
      timeout: 8000,
    });

    const image = Array.isArray(result.ogImage) ? result.ogImage[0]?.url : undefined;
    return {
      title: result.ogTitle ?? result.twitterTitle ?? result.dcTitle,
      description: result.ogDescription ?? result.twitterDescription ?? result.dcDescription,
      imageUrl: image,
    };
  } catch {
    return {};
  }
}
