import sprite from '../assets/icons.svg?raw';

export type IconName = 'brush' | 'rectangle' | 'crop' | 'transform' | 'eyedropper' | 'selection' | 'eraser' | 'generate' | 'remove' |
  'eye' | 'eye-off' | 'layers' | 'history' | 'document' | 'folder' | 'plus' | 'trash' | 'undo' | 'redo' |
  'up' | 'down' | 'chevron-down' | 'close' | 'check' | 'settings' | 'grip' | 'swap' | 'colors' | 'image';

let installed = false;

export function icon(name: IconName): SVGSVGElement {
  if (!installed) {
    const definitions = new DOMParser().parseFromString(sprite, 'image/svg+xml').documentElement;
    definitions.setAttribute('class', 'icon-definitions');
    document.body.prepend(document.importNode(definitions, true));
    installed = true;
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  use.setAttribute('href', '#icon-' + name);
  svg.append(use);
  return svg;
}

export function hydrateIcons(root: ParentNode = document): void {
  for (const element of root.querySelectorAll<HTMLElement>('[data-icon]')) {
    element.replaceChildren(icon(element.dataset.icon as IconName));
  }
}
