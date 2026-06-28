import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchArticleBody } from '../src/content/article.js';

function htmlResponse(html: string, contentType = 'text/html; charset=utf-8'): Response {
  return new Response(html, { status: 200, headers: { 'content-type': contentType } });
}

/** Длинная статья: 3 абзаца — выше порога readability (~500) и нашего articleMinChars (200). */
const ARTICLE_HTML = `<!doctype html><html><head><title>Как работают эмбеддинги</title></head>
<body><article>
<h1>Как работают эмбеддинги</h1>
<p>Эмбеддинг — это плотный вектор, в который модель упаковывает смысл текста, чтобы близкие по смыслу
фрагменты оказывались рядом в многомерном пространстве, а далёкие — далеко друг от друга.</p>
<p>Поиск по эмбеддингам сравнивает векторы косинусной близостью: чем меньше угол между ними, тем выше
семантическое сходство, и тем выше документ окажется в выдаче независимо от точных слов запроса.</p>
<p>Локальные модели позволяют считать эмбеддинги без облака, что снижает стоимость и задержку, но
требует памяти и подходящего железа для приемлемой скорости инференса на больших корпусах.</p>
</article></body></html>`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchArticleBody', () => {
  it('skip-домен (YouTube) → null без сетевого запроса', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await fetchArticleBody('https://www.youtube.com/watch?v=abc')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skip-домен по поддомену (m.twitter.com) → null', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await fetchArticleBody('https://m.twitter.com/user/status/1')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('невалидный URL → null', async () => {
    expect(await fetchArticleBody('не-урл')).toBeNull();
  });

  it('нормальная статья → извлечённый текст', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(ARTICLE_HTML)));
    const body = await fetchArticleBody('https://habr.com/ru/articles/1');
    expect(body).toBeTruthy();
    expect(body).toContain('Эмбеддинг');
    expect(body).toContain('косинусной близостью');
    // нормализация схлопывает переводы строк в пробелы
    expect(body).not.toContain('\n');
  });

  it('SPA-оболочка (пустой div#root) → null (< articleMinChars)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => htmlResponse('<!doctype html><html><body><div id="root"></div></body></html>')),
    );
    expect(await fetchArticleBody('https://spa.example.com/app')).toBeNull();
  });

  it('не-HTML контент (PDF по ссылке) → null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse('%PDF-1.7 ...', 'application/pdf')));
    expect(await fetchArticleBody('https://example.com/file.pdf')).toBeNull();
  });

  it('HTTP-ошибка (404) → null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    expect(await fetchArticleBody('https://example.com/missing')).toBeNull();
  });

  it('сетевой сбой (fetch бросил) → null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
    expect(await fetchArticleBody('https://example.com/down')).toBeNull();
  });
});
