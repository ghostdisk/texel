export interface LayerChoice {
  id: string;
  label: string;
  disabled: boolean;
}

/** A shared layer-reference control; callers supply eligibility and edit handling. */
export function drawLayerSelect(container: HTMLElement, label: string, value: string | null, choices: readonly LayerChoice[], change: (id: string | null) => void): void {
  const field = document.createElement('label');
  field.className = 'layer-select-field';
  const text = document.createElement('span');
  text.textContent = label;
  const select = document.createElement('select');
  select.setAttribute('aria-label', label);
  select.add(new Option('None', ''));
  for (const choice of choices) {
    const option = new Option(choice.label, choice.id);
    option.disabled = choice.disabled;
    if (choice.disabled) option.title = 'Would create a circular dependency';
    select.add(option);
  }
  if (value && !choices.some((choice) => choice.id === value)) {
    const missing = new Option('Missing layer', value);
    missing.disabled = true;
    select.add(missing);
  }
  select.value = value ?? '';
  select.onchange = () => change(select.value || null);
  field.append(text, select);
  container.append(field);
}