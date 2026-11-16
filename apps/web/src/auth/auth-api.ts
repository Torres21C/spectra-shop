import type { ApiErrorResponse, AuthUser, LoginResponse } from '@spectra/contracts';

const IDENTITY_BASE_URL = (
  import.meta.env.VITE_IDENTITY_API_URL ?? 'http://127.0.0.1:3001'
).replace(/\/$/, '');

export class AuthApiError extends Error {
  readonly code: string | undefined;
  readonly requestId: string | undefined;

  constructor(message: string, code?: string, requestId?: string) {
    super(message);
    this.name = 'AuthApiError';
    this.code = code;
    this.requestId = requestId;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeError(value: unknown): ApiErrorResponse | undefined {
  if (!isRecord(value)) return undefined;
  const { statusCode, code, message, requestId, timestamp } = value;
  if (
    typeof statusCode !== 'number' ||
    typeof code !== 'string' ||
    typeof message !== 'string' ||
    typeof requestId !== 'string' ||
    typeof timestamp !== 'string'
  ) {
    return undefined;
  }
  return { statusCode, code, message, requestId, timestamp };
}

function decodeUser(value: unknown): AuthUser {
  if (!isRecord(value)) throw new AuthApiError('La respuesta de identidad no es válida');
  const { id, fullName, email, role, createdAt } = value;
  if (
    typeof id !== 'string' ||
    typeof fullName !== 'string' ||
    typeof email !== 'string' ||
    (role !== 'CLIENTE' && role !== 'ADMIN') ||
    typeof createdAt !== 'string'
  ) {
    throw new AuthApiError('La respuesta de identidad no es válida');
  }
  return { id, fullName, email, role, createdAt };
}

async function parseResponse(response: Response): Promise<unknown> {
  const payload: unknown = JSON.parse(await response.text());
  if (!response.ok) {
    const error = decodeError(payload);
    throw new AuthApiError(
      error?.message ?? 'No fue posible completar la solicitud',
      error?.code,
      error?.requestId,
    );
  }
  return payload;
}

export async function csrfToken(): Promise<string> {
  const response = await fetch(`${IDENTITY_BASE_URL}/auth/csrf`, {
    method: 'GET',
    credentials: 'include',
    redirect: 'error',
    headers: { Accept: 'application/json' },
  });
  const payload = await parseResponse(response);
  if (!isRecord(payload) || typeof payload.csrfToken !== 'string') {
    throw new AuthApiError('No fue posible preparar la solicitud');
  }
  return payload.csrfToken;
}

async function mutate(path: string, body?: Record<string, unknown>): Promise<unknown> {
  const csrf = await csrfToken();
  const response = await fetch(`${IDENTITY_BASE_URL}${path}`, {
    method: 'POST',
    credentials: 'include',
    redirect: 'error',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf,
    },
    body: JSON.stringify(body ?? {}),
  });
  return parseResponse(response);
}

export async function register(input: {
  fullName: string;
  email: string;
  password: string;
  passwordConfirmation: string;
  academicDataAccepted: boolean;
}): Promise<string> {
  const payload = await mutate('/auth/register', input);
  if (!isRecord(payload) || typeof payload.message !== 'string') {
    throw new AuthApiError('La respuesta de identidad no es válida');
  }
  return payload.message;
}

export async function login(input: {
  email: string;
  password: string;
  returnTo?: string;
}): Promise<LoginResponse> {
  const payload = await mutate('/auth/login', input);
  if (!isRecord(payload) || typeof payload.returnTo !== 'string') {
    throw new AuthApiError('La respuesta de identidad no es válida');
  }
  return { user: decodeUser(payload.user), returnTo: payload.returnTo };
}

export async function logout(): Promise<void> {
  await mutate('/auth/logout');
}

export async function refreshSession(): Promise<void> {
  await mutate('/auth/refresh');
}

export async function getMe(signal?: AbortSignal): Promise<AuthUser | undefined> {
  const response = await fetch(`${IDENTITY_BASE_URL}/auth/me`, {
    method: 'GET',
    credentials: 'include',
    redirect: 'error',
    headers: { Accept: 'application/json' },
    ...(signal ? { signal } : {}),
  });
  if (response.status === 401) return undefined;
  return decodeUser(await parseResponse(response));
}

export function safeClientReturn(value: string): string {
  return /^#\/[A-Za-z0-9/_-]*$/.test(value) ? value : '#/';
}
