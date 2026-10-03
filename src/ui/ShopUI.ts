import type { ShopItem } from '../economy/Catalog';
import type { UIStack } from './UIStack';
import { formatMoney } from '../core/math';

export interface ShopTab {
  id: string;
  label: string;
  items: () => ShopItem[];
}

export interface ShopSpec {
  title: string;
  subtitle?: string;
  tabs: ShopTab[];
  /** Live preview when an item is highlighted (appearance, paint). */
  onPreview?: (item: ShopItem | null, tab: string) => void;
  /** Attempt purchase; return a message to toast (null = silent). */
  onBuy: (item: ShopItem, tab: string) => string | null;
  onClose?: () => void;
  buyLabel?: (item: ShopItem) => string;
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const hex = (n: number): string => '#' + n.toString(16).padStart(6, '0');

/** Side-panel store UI shared by every shop (gun store, barber, clothes, tattoos, mod shop, properties). */
export class ShopUI {
  readonly el: HTMLDivElement;
  private spec: ShopSpec | null = null;
  private tab = '';
  private sel: ShopItem | null = null;
  private body: HTMLDivElement;
  private tabsEl: HTMLDivElement;
  private footer: HTMLDivElement;
  private head: HTMLDivElement;

  constructor(parent: HTMLElement, private ui: UIStack, private cash: () => number, private toast: (m: string) => void) {
    this.el = document.createElement('div');
    this.el.className = 'shop';
    this.el.innerHTML = `<div class="shop-head"></div><div class="tabs"></div><div class="shop-body"></div><div class="shop-foot"></div>`;
    parent.appendChild(this.el);
    this.head = this.el.querySelector('.shop-head')!;
    this.tabsEl = this.el.querySelector('.tabs')!;
    this.body = this.el.querySelector('.shop-body')!;
    this.footer = this.el.querySelector('.shop-foot')!;
    this.el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const b = t.closest<HTMLElement>('[data-a]');
      if (!b || !this.spec) return;
      e.stopPropagation();
      const a = b.dataset.a!;
      if (a === 'close') this.ui.pop(this.el);
      else if (a === 'tab') {
        this.tab = b.dataset.id!;
        this.sel = null;
        this.spec.onPreview?.(null, this.tab);
        this.render();
      } else if (a === 'item') {
        const it = this.items().find((x) => x.id === b.dataset.id);
        if (!it) return;
        this.sel = it;
        this.spec.onPreview?.(it, this.tab);
        this.render();
      } else if (a === 'buy' && this.sel) {
        const msg = this.spec.onBuy(this.sel, this.tab);
        if (msg) this.toast(msg);
        const id = this.sel.id;
        this.sel = this.items().find((x) => x.id === id) ?? null;
        this.render();
      }
    });
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  get isOpen(): boolean {
    return this.ui.has(this.el);
  }

  private items(): ShopItem[] {
    return this.spec?.tabs.find((t) => t.id === this.tab)?.items() ?? [];
  }

  open(spec: ShopSpec): void {
    this.spec = spec;
    this.tab = spec.tabs[0]?.id ?? '';
    this.sel = null;
    this.render();
    this.ui.push({
      el: this.el,
      onClose: () => {
        const s = this.spec;
        this.spec = null;
        s?.onPreview?.(null, '');
        s?.onClose?.();
      },
      onBack: () => {
        if (this.sel) {
          this.sel = null;
          this.spec?.onPreview?.(null, this.tab);
          this.render();
          return false;
        }
        return true;
      },
    });
    (this.el.querySelector('.card') as HTMLElement | null)?.focus();
  }

  refresh(): void {
    if (this.spec) this.render();
  }

  private render(): void {
    const s = this.spec!;
    this.head.innerHTML = `<div><div class="t">${esc(s.title)}</div>${s.subtitle ? `<div class="muted">${esc(s.subtitle)}</div>` : ''}</div>
      <div class="cash">${formatMoney(this.cash())}</div><button class="btn small" data-a="close" aria-label="Close">✕</button>`;
    this.tabsEl.style.display = s.tabs.length > 1 ? '' : 'none';
    this.tabsEl.innerHTML = s.tabs.map((t) => `<button class="btn small${t.id === this.tab ? ' sel' : ''}" data-a="tab" data-id="${t.id}">${esc(t.label)}</button>`).join('');
    const items = this.items();
    this.body.innerHTML = items.length
      ? `<div class="grid">${items.map((it) => {
        const price = it.badge !== undefined ? `<span class="own">${esc(it.badge)}</span>` : it.owned ? '<span class="own">OWNED</span>' : it.price > 0 ? formatMoney(it.price) : '<span class="own">FREE</span>';
        const cls = `card${this.sel?.id === it.id ? ' sel' : ''}${it.disabled ? ' dis' : ''}`;
        return `<button class="${cls}" data-a="item" data-id="${esc(it.id)}">${it.swatch !== undefined ? `<i class="sw" style="background:${hex(it.swatch)}"></i>` : ''}<span class="t">${esc(it.name)}</span>${it.desc ? `<span class="muted">${esc(it.desc)}</span>` : ''}<span class="p">${price}</span></button>`;
      }).join('')}</div>`
      : '<div class="muted" style="padding:20px;text-align:center">Nothing here yet.</div>';
    if (this.sel) {
      const it = this.sel;
      const afford = it.owned || it.price <= this.cash();
      const label = s.buyLabel?.(it) ?? (it.owned ? 'USE' : `BUY ${it.price > 0 ? formatMoney(it.price) : ''}`);
      this.footer.innerHTML = `<span class="t">${esc(it.name)}</span><button class="btn primary" data-a="buy" ${it.disabled || !afford ? 'disabled' : ''}>${esc(label)}</button>`;
      this.footer.style.display = '';
    } else this.footer.style.display = 'none';
  }
}
