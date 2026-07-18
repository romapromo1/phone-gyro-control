export interface EditorField {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  unit?: string;
  get: () => number;
  set: (value: number) => void;
}

export interface EditorTarget {
  id: string;
  label: string;
  group: string;
  fields: EditorField[];
  afterApply?: () => void;
}

interface StoredEditorState {
  version: 1;
  values: Record<string, Record<string, number>>;
}

interface SceneEditorPanelOptions {
  trigger: HTMLButtonElement;
  panel: HTMLElement;
  close: HTMLButtonElement;
  groupSelect: HTMLSelectElement;
  targetSelect: HTMLSelectElement;
  controls: HTMLElement;
  resetTarget: HTMLButtonElement;
  resetAll: HTMLButtonElement;
  targetProvider: () => EditorTarget[];
  storageKey?: string;
}

export const SCENE_EDITOR_STORAGE_KEY = 'holobox-scene-editor-v1';

export class SceneEditorPanel {
  private readonly options: SceneEditorPanelOptions;
  private readonly storageKey: string;
  private readonly targets = new Map<string, EditorTarget>();
  private state: StoredEditorState;
  private activeTargetId = '';

  constructor(options: SceneEditorPanelOptions) {
    this.options = options;
    this.storageKey = options.storageKey || SCENE_EDITOR_STORAGE_KEY;
    this.state = this.readState();

    options.trigger.addEventListener('click', () => this.toggle());
    options.close.addEventListener('click', () => this.close());
    options.groupSelect.addEventListener('change', () => this.renderTargetOptions());
    options.targetSelect.addEventListener('change', () => {
      this.activeTargetId = options.targetSelect.value;
      this.renderControls();
    });
    options.resetTarget.addEventListener('click', () => this.resetActiveTarget());
    options.resetAll.addEventListener('click', () => this.resetAll());
  }

  refresh(applyStoredValues = true) {
    const previousTarget = this.activeTargetId;
    this.targets.clear();
    for (const target of this.options.targetProvider()) {
      if (!target.id || this.targets.has(target.id)) continue;
      this.targets.set(target.id, target);
      if (applyStoredValues) this.applyStoredTarget(target);
    }

    if (!this.options.panel.classList.contains('hidden')) {
      this.renderGroupOptions();
      if (previousTarget && this.targets.has(previousTarget)) {
        this.activeTargetId = previousTarget;
      }
      this.renderTargetOptions();
    }
  }

  applyStoredValues() {
    this.refresh(true);
  }

  private toggle() {
    if (this.options.panel.classList.contains('hidden')) {
      this.open();
    } else {
      this.close();
    }
  }

  private open() {
    this.options.panel.classList.remove('hidden');
    this.refresh(true);
    this.renderGroupOptions();
    this.renderTargetOptions();
  }

  private close() {
    this.options.panel.classList.add('hidden');
  }

  private renderGroupOptions() {
    const previous = this.options.groupSelect.value;
    const groups = [...new Set([...this.targets.values()].map((target) => target.group))]
      .sort((left, right) => left.localeCompare(right, 'ru'));
    this.options.groupSelect.replaceChildren(...groups.map((group) => {
      const option = document.createElement('option');
      option.value = group;
      option.textContent = group;
      return option;
    }));
    this.options.groupSelect.value = groups.includes(previous) ? previous : (groups[0] || '');
  }

  private renderTargetOptions() {
    const group = this.options.groupSelect.value;
    const visibleTargets = [...this.targets.values()]
      .filter((target) => target.group === group)
      .sort((left, right) => left.label.localeCompare(right.label, 'ru'));
    this.options.targetSelect.replaceChildren(...visibleTargets.map((target) => {
      const option = document.createElement('option');
      option.value = target.id;
      option.textContent = target.label;
      return option;
    }));

    if (!visibleTargets.some((target) => target.id === this.activeTargetId)) {
      this.activeTargetId = visibleTargets[0]?.id || '';
    }
    this.options.targetSelect.value = this.activeTargetId;
    this.renderControls();
  }

  private renderControls() {
    const target = this.targets.get(this.activeTargetId);
    this.options.controls.replaceChildren();
    if (!target) {
      const empty = document.createElement('p');
      empty.className = 'settings-empty';
      empty.textContent = 'В этой группе пока нет редактируемых элементов.';
      this.options.controls.append(empty);
      return;
    }

    for (const field of target.fields) {
      const row = document.createElement('div');
      row.className = 'setting-item';
      row.dataset.fieldId = field.id;
      const label = document.createElement('label');
      label.className = 'setting-label';
      label.htmlFor = `scene-editor-${target.id}-${field.id}`;
      const name = document.createElement('span');
      name.textContent = field.label;
      const value = document.createElement('span');
      value.textContent = formatValue(field.get(), field);
      label.append(name, value);

      const inputs = document.createElement('div');
      inputs.className = 'setting-inputs';
      const range = document.createElement('input');
      range.type = 'range';
      range.id = `scene-editor-${target.id}-${field.id}`;
      range.min = String(field.min);
      range.max = String(field.max);
      range.step = String(field.step);
      range.value = String(clamp(field.get(), field.min, field.max));
      const number = document.createElement('input');
      number.type = 'number';
      number.min = String(field.min);
      number.max = String(field.max);
      number.step = String(field.step);
      number.value = String(roundForStep(field.get(), field.step));

      const update = (rawValue: string) => {
        const parsed = Number(rawValue);
        if (!Number.isFinite(parsed)) return;
        const next = clamp(parsed, field.min, field.max);
        field.set(next);
        target.afterApply?.();
        this.syncRenderedControls(target);
        this.storeTarget(target);
      };
      range.addEventListener('input', () => update(range.value));
      number.addEventListener('input', () => update(number.value));
      inputs.append(range, number);
      row.append(label, inputs);
      this.options.controls.append(row);
    }
  }

  private syncRenderedControls(target: EditorTarget) {
    const rows = [...this.options.controls.querySelectorAll<HTMLElement>('.setting-item')];
    for (const row of rows) {
      const field = target.fields.find((candidate) => candidate.id === row.dataset.fieldId);
      if (!field) continue;
      const next = clamp(field.get(), field.min, field.max);
      const value = row.querySelector<HTMLElement>('.setting-label span:last-child');
      const range = row.querySelector<HTMLInputElement>('input[type="range"]');
      const number = row.querySelector<HTMLInputElement>('input[type="number"]');
      if (value) value.textContent = formatValue(next, field);
      if (range) range.value = String(next);
      if (number) number.value = String(roundForStep(next, field.step));
    }
  }

  private applyStoredTarget(target: EditorTarget) {
    const storedTarget = this.state.values[target.id];
    if (!storedTarget) return;
    for (const field of target.fields) {
      const value = storedTarget[field.id];
      if (!Number.isFinite(value)) continue;
      field.set(clamp(value, field.min, field.max));
    }
    target.afterApply?.();
  }

  private storeTarget(target: EditorTarget) {
    const values: Record<string, number> = {};
    for (const field of target.fields) values[field.id] = field.get();
    this.state.values[target.id] = values;
    this.writeState();
  }

  private resetActiveTarget() {
    const target = this.targets.get(this.activeTargetId);
    if (!target) return;
    delete this.state.values[target.id];
    for (const field of target.fields) field.set(field.defaultValue);
    target.afterApply?.();
    this.writeState();
    this.renderControls();
  }

  private resetAll() {
    this.state = { version: 1, values: {} };
    for (const target of this.targets.values()) {
      for (const field of target.fields) field.set(field.defaultValue);
      target.afterApply?.();
    }
    this.writeState();
    this.renderControls();
  }

  private readState(): StoredEditorState {
    try {
      const parsed = JSON.parse(localStorage.getItem(this.storageKey) || 'null') as StoredEditorState | null;
      if (parsed?.version === 1 && parsed.values && typeof parsed.values === 'object') return parsed;
    } catch {
      // A malformed operator setting must never block the kiosk flow.
    }
    return { version: 1, values: {} };
  }

  private writeState() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.state));
    } catch {
      // Private browsing or a full storage quota must not break the experience.
    }
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function roundForStep(value: number, step: number) {
  const decimals = Math.max(0, String(step).split('.')[1]?.length || 0);
  return Number(value.toFixed(decimals));
}

function formatValue(value: number, field: EditorField) {
  return `${roundForStep(value, field.step)}${field.unit || ''}`;
}
