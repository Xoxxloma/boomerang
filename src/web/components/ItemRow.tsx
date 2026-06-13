import type { ItemDTO } from '../lib/types.js';
import { TYPE_GLYPH, TYPE_LABEL, relDate } from '../lib/format.js';
import { hapticTap } from '../lib/telegram.js';

/** Строка списка-записи: ведущий глиф типа + заголовок + моно-meta. Тап открывает карточку. */
export function ItemRow({ item, onOpen }: { item: ItemDTO; onOpen: (it: ItemDTO) => void }) {
  return (
    <button
      className="item-row"
      onClick={() => {
        hapticTap();
        onOpen(item);
      }}
    >
      <span className="item-glyph" aria-hidden>
        {TYPE_GLYPH[item.type]}
      </span>
      <span className="item-main">
        <span className="item-title">{item.name}</span>
        <span className="item-meta">
          <span className="meta">{TYPE_LABEL[item.type]}</span>
          {item.sourceChat && <span className="meta">· {item.sourceChat}</span>}
          <span className="meta">· {relDate(item.createdAt)}</span>
        </span>
      </span>
    </button>
  );
}
