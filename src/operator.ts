interface StationStatus {
  stationId: string;
  state: string;
  desktopConnected: boolean;
  controllerConnected: boolean;
  telemetryAgeMs: number | null;
}

interface HealthStatus {
  uptimeSeconds: number;
  stations: StationStatus[];
  metrics: Record<string, number>;
  imageGenerationConfigured?: boolean;
  imageGenerationModel?: string | null;
}

const tokenInput = document.getElementById('operator-token') as HTMLInputElement;
const connectButton = document.getElementById('operator-connect') as HTMLButtonElement;
const message = document.getElementById('operator-message') as HTMLElement;
const stationsContainer = document.getElementById('stations') as HTMLElement;
let operatorToken = sessionStorage.getItem('gyro-operator-token') || '';
let refreshTimer: number | null = null;

tokenInput.value = operatorToken;
connectButton.addEventListener('click', () => {
  operatorToken = tokenInput.value.trim();
  sessionStorage.setItem('gyro-operator-token', operatorToken);
  void refresh();
});

stationsContainer.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  if (!button) return;
  void runAction(button.dataset.station || 'main', button.dataset.action || '');
});

async function refresh() {
  if (!operatorToken) {
    message.textContent = 'Введите OPERATOR_TOKEN.';
    return;
  }
  try {
    const response = await api('/api/operator/status');
    const status = await response.json() as HealthStatus;
    renderStations(status);
    const generationStatus = status.imageGenerationConfigured
      ? `генератор подключён (${status.imageGenerationModel || 'модель не указана'})`
      : 'генератор не настроен';
    message.textContent = `Сервер работает ${formatDuration(status.uptimeSeconds)}. Сессий завершено: ${status.metrics.sessionsCompleted || 0}; ${generationStatus}.`;
  } catch (error) {
    message.textContent = error instanceof Error ? error.message : 'Ошибка связи с сервером.';
  } finally {
    if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => void refresh(), 2_000);
  }
}

async function runAction(stationId: string, action: string) {
  try {
    await api(`/api/operator/stations/${encodeURIComponent(stationId)}/${action}`, { method: 'POST' });
    await refresh();
  } catch (error) {
    message.textContent = error instanceof Error ? error.message : 'Команда не выполнена.';
  }
}

async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(path, {
    ...init,
    cache: 'no-store',
    headers: { ...init.headers, Authorization: `Bearer ${operatorToken}` },
  });
  if (!response.ok) throw new Error(response.status === 401 ? 'Неверный OPERATOR_TOKEN.' : `HTTP ${response.status}`);
  return response;
}

function renderStations(status: HealthStatus) {
  stationsContainer.replaceChildren(...status.stations.map((station) => {
    const card = document.createElement('article');
    card.className = 'glass-panel station-card';
    card.innerHTML = `
      <h2>${escapeHtml(station.stationId)}</h2>
      <dl>
        <dt>Состояние</dt><dd>${escapeHtml(station.state)}</dd>
        <dt>Holobox</dt><dd>${station.desktopConnected ? 'онлайн' : 'офлайн'}</dd>
        <dt>Контроллер</dt><dd>${station.controllerConnected ? 'подключён' : 'нет'}</dd>
        <dt>Телеметрия</dt><dd>${station.telemetryAgeMs === null ? '—' : `${station.telemetryAgeMs} мс`}</dd>
      </dl>
      <div class="operator-actions">
        <button class="glow-btn" data-action="calibrate" data-station="${escapeHtml(station.stationId)}">Калибровать</button>
        <button class="glow-btn" data-action="reset" data-station="${escapeHtml(station.stationId)}">Новый гость</button>
      </div>`;
    return card;
  }));
}

function formatDuration(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours} ч ${minutes} мин`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character] || character);
}

if (operatorToken) void refresh();
