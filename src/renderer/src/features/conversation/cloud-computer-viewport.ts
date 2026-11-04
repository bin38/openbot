/** A native cloud viewer must yield to visible DOM dialogs and menus. */
export function visibleCloudComputerOverlay(): boolean {
  for (const element of document.querySelectorAll<HTMLElement>(
    '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
  )) {
    if (element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden") return true;
  }
  return false;
}
