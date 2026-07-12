import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const layout = readFileSync(new URL('../src/app/panel-layout.ts', import.meta.url), 'utf8');
const handlers = readFileSync(new URL('../src/app/event-handlers.ts', import.meta.url), 'utf8');
const mobileNav = readFileSync(new URL('../src/app/mobile-primary-nav.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles/main.css', import.meta.url), 'utf8');
const shell = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const search = readFileSync(new URL('../src/components/SearchModal.ts', import.meta.url), 'utf8');
const popup = readFileSync(new URL('../src/components/MapPopup.ts', import.meta.url), 'utf8');
const settings = readFileSync(new URL('../src/components/UnifiedSettings.ts', import.meta.url), 'utf8');
const deepDive = readFileSync(new URL('../src/components/CountryDeepDivePanel.ts', import.meta.url), 'utf8');

describe('mobile P0 navigation contract (#5201)', () => {
  it('renders the five primary destinations in a real bottom navigation landmark', () => {
    assert.match(layout, /<nav class="mobile-tab-bar"[^>]*aria-label="Primary"/);
    for (const tab of ['today', 'map', 'search', 'alerts', 'more']) {
      assert.match(layout, new RegExp(`data-mobile-tab="${tab}"`));
    }
  });

  it('replaces the mobile footer, hamburger, and search FAB without affecting desktop', () => {
    assert.doesNotMatch(layout, /id="searchMobileFab"/);
    assert.doesNotMatch(layout, /id="hamburgerBtn"/);
    assert.match(css, /@media \(max-width: 768px\)[\s\S]*?\.site-footer\s*\{[^}]*display:\s*none/);
    assert.doesNotMatch(css, /\.hamburger-btn/);
    assert.doesNotMatch(css, /\.search-mobile-fab/);
    assert.match(css, /\.mobile-tab-bar\s*\{/);
  });

  it('wires Today, Map, Search, Alerts, and More as distinct actions', () => {
    assert.match(mobileNav, /private setupTabBar\(\): void/);
    assert.match(mobileNav, /case 'today':/);
    assert.match(mobileNav, /case 'map':/);
    assert.match(mobileNav, /case 'search':/);
    assert.match(mobileNav, /case 'alerts':/);
    assert.match(mobileNav, /case 'more':/);
  });

  it('defaults first-time mobile visitors to the collapsed-map Today state before hydration', () => {
    assert.match(layout, /loadFromStorage<boolean>\('mobile-map-collapsed', true\)/);
    assert.match(shell, /localStorage\.getItem\('mobile-map-collapsed'\)!=='false'/);
  });

  it('provides an account mount inside More instead of hiding auth on mobile', () => {
    assert.match(layout, /id="mobileAuthWidgetMount"/);
    assert.match(mobileNav, /mobileAuthWidgetMount/);
  });

  it('routes every P0 overlay family through the shared browser-history manager', () => {
    assert.match(mobileNav, /overlayHistory\.open\('menu'/);
    assert.match(mobileNav, /overlayHistory\.replace\('menu', 'region'/);
    assert.match(search, /overlayHistory\.open\('search'/);
    assert.match(popup, /overlayHistory\.open\('map-popup'/);
    assert.match(settings, /overlayHistory\.open\('settings'/);
    assert.match(deepDive, /overlayHistory\.open\('deep-dive'/);
    assert.match(handlers, /history\.replaceState\(history\.state, '', shareUrl\)/);
  });
});
