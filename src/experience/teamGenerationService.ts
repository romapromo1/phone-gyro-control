import type { TeamDefinition } from './TeamSelection3D';

export type DetectedGender = 'male' | 'female' | 'unknown';

const BACKEND_URL = (import.meta.env.VITE_BACKEND_URL || '').replace(/\/$/, '');
const GENERATION_ENDPOINT = '/api/generate-image';
const MAX_ERROR_DETAIL_LENGTH = 500;

export interface TeamGenerationResult {
  imageDataUrl?: string;
  imageUrl?: string;
}

interface BackendErrorPayload {
  error?: unknown;
  message?: unknown;
  detail?: unknown;
  requestId?: unknown;
  upstreamStatus?: unknown;
  upstreamErrorType?: unknown;
}

/**
 * A structured error that keeps enough context to diagnose a broken deployment
 * without dumping a full HTML error page (or an upstream response) to the log.
 */
export class TeamGenerationError extends Error {
  readonly status: number;
  readonly endpoint: string;
  readonly backendMessage: string;

  constructor(status: number, endpoint: string, backendMessage: string) {
    super(buildGenerationErrorMessage(status, endpoint, backendMessage));
    this.name = 'TeamGenerationError';
    this.status = status;
    this.endpoint = endpoint;
    this.backendMessage = backendMessage;
  }

  toUserMessage() {
    switch (this.status) {
      case 401:
      case 403:
        return 'Экран не авторизован на сервере. Проверьте kiosk-токен.';
      case 404:
        return isLocalOrigin()
          ? 'Сервер генерации не подключён. Запустите приложение через npm run dev, а не напрямую через Vite.'
          : 'Маршрут генерации отсутствует в Render-сервисе. Проверьте, что сервис запускается командой npm start.';
      case 413:
        return 'Фотография слишком большая для отправки. Переснимите фото.';
      case 429:
        return 'Сервис генерации занят. Попробуйте ещё раз через несколько секунд.';
      case 503:
        return this.backendMessage === 'image-generation-not-configured'
          ? 'Генерация не настроена на сервере. Проверьте OPENROUTER_API_KEY.'
          : 'Сервис генерации временно недоступен. Попробуйте ещё раз.';
      default:
        if (this.status === 0) return 'Нет связи с сервером генерации. Проверьте запуск приложения и сеть.';
        return 'Не удалось запустить генерацию изображения. Попробуйте ещё раз.';
    }
  }
}

function isLocalOrigin() {
  if (typeof window === 'undefined') return false;
  return ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
}

export async function submitTeamGeneration(
  photoDataUrl: string,
  team: TeamDefinition,
  kioskToken: string,
  signal?: AbortSignal,
) {
  const base64Image = photoDataUrl.replace(/^data:image\/[^;]+;base64,/, '');
  const promptText = buildTeamPrompt(team, 'unknown');
  const endpoint = `${BACKEND_URL}${GENERATION_ENDPOINT}`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(kioskToken ? { Authorization: `Bearer ${kioskToken}` } : {}),
      },
      body: JSON.stringify({
        promptText,
        base64Image,
        teamId: team.id,
        teamName: team.name,
      }),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    const detail = error instanceof Error ? error.message : 'Network request failed.';
    throw new TeamGenerationError(0, endpoint, detail);
  }

  const responseText = await response.text();
  const responseBody = parseJson(responseText);
  if (!response.ok) {
    throw new TeamGenerationError(
      response.status,
      endpoint,
      extractBackendMessage(responseBody, responseText, response.statusText),
    );
  }

  if (!isTeamGenerationResult(responseBody)) {
    throw new TeamGenerationError(
      response.status,
      endpoint,
      responseText ? 'Backend returned an invalid success payload.' : 'Backend returned an empty response.',
    );
  }

  return responseBody;
}

function parseJson(value: string): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isTeamGenerationResult(value: unknown): value is TeamGenerationResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as TeamGenerationResult;
  return (
    (typeof result.imageDataUrl === 'string' && result.imageDataUrl.length > 0) ||
    (typeof result.imageUrl === 'string' && result.imageUrl.length > 0)
  );
}

function extractBackendMessage(
  parsedBody: unknown,
  responseText: string,
  statusText: string,
) {
  if (parsedBody && typeof parsedBody === 'object') {
    const payload = parsedBody as BackendErrorPayload;
    for (const candidate of [payload.error, payload.message, payload.detail]) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return truncateDetail(`${candidate}${buildBackendDiagnosticSuffix(payload)}`);
      }
    }
  }

  // Standalone Vite and reverse proxies commonly answer with an HTML 404 page.
  // Reducing it to plain text keeps the console useful and avoids huge log entries.
  const plainText = responseText
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return truncateDetail(plainText || statusText || 'No error details returned.');
}

function buildBackendDiagnosticSuffix(payload: BackendErrorPayload) {
  const details: string[] = [];
  if (typeof payload.upstreamStatus === 'number' && Number.isInteger(payload.upstreamStatus)) {
    details.push(`upstream=${payload.upstreamStatus}`);
  }
  if (
    typeof payload.upstreamErrorType === 'string'
    && /^[a-zA-Z0-9_-]{1,80}$/.test(payload.upstreamErrorType)
  ) {
    details.push(`type=${payload.upstreamErrorType}`);
  }
  if (
    typeof payload.requestId === 'string'
    && /^[a-f0-9-]{20,64}$/i.test(payload.requestId)
  ) {
    details.push(`request=${payload.requestId}`);
  }
  return details.length ? ` (${details.join(', ')})` : '';
}

function truncateDetail(value: string) {
  const normalized = value.trim();
  return normalized.length > MAX_ERROR_DETAIL_LENGTH
    ? `${normalized.slice(0, MAX_ERROR_DETAIL_LENGTH)}…`
    : normalized;
}

function buildGenerationErrorMessage(status: number, endpoint: string, backendMessage: string) {
  const statusMessage = status > 0
    ? `Generation backend returned HTTP ${status} for POST ${endpoint}.`
    : `Generation backend could not be reached for POST ${endpoint}.`;
  const deploymentHint = status === 404
    ? ' The page is not connected to the Node API. Start the full app with "npm run dev" locally or "npm start" on Render; do not run standalone Vite.'
    : '';
  return `${statusMessage}${deploymentHint} Backend response: ${backendMessage}`;
}

export function buildTeamPrompt(team: TeamDefinition, gender: DetectedGender) {
  const genderGuard = gender === 'female'
    ? 'На исходном фото женщина: сохрани женский пол, женскую внешность и естественные женские черты. Не превращай её в мужчину.'
    : gender === 'male'
      ? 'На исходном фото мужчина: сохрани мужской пол, мужскую внешность и естественные мужские черты. Не превращай его в женщину.'
      : 'Сохрани пол, гендерную презентацию и внешность человека строго такими же, как на исходном фото. Не меняй пол человека.';

  return `${genderGuard} Изобрази меня в форме сборной ${team.promptCountry}, в которой она будет играть в финале Чемпионата мира 2026. Фото должно быть в полный рост. Ноги не должны обрезаться. Смотрю прямо в камеру. Фон идеально белый. Позади чуть сбоку падает лёгкая тень, как будто я стою в циклораме в 50 см от стены. Детали лица сохрани. Выражение лица сохрани. Можешь сделать чуть моложе и свежее. Фотореализм, естественная анатомия, одна фигура в кадре, фото в 4K.`;
}
