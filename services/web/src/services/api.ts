import axios from 'axios';
import type { InternalAxiosRequestConfig } from 'axios';

const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

type RetryConfig = InternalAxiosRequestConfig & { _retry?: boolean };

let refreshRequest: Promise<void> | null = null;

api.interceptors.response.use(undefined, async (error: unknown) => {
  if (!axios.isAxiosError(error) || error.response?.status !== 401) {
    return Promise.reject(error);
  }

  const request = error.config as RetryConfig | undefined;
  const url = request?.url ?? '';
  if (
    !request ||
    request._retry ||
    /\/auth\/(login|signup|refresh|logout)(?:[?#]|$)/.test(url)
  ) {
    return Promise.reject(error);
  }

  request._retry = true;
  try {
    refreshRequest ??= api
      .post('/auth/refresh')
      .then(() => undefined)
      .finally(() => {
        refreshRequest = null;
      });
    await refreshRequest;
    return await api.request(request);
  } catch {
    return Promise.reject(error);
  }
});

export function apiErrorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const data: unknown = error.response?.data;
    if (
      typeof data === 'object' &&
      data !== null &&
      'message' in data &&
      typeof data.message === 'string'
    ) {
      return data.message;
    }
  }
  return fallback;
}

export default api;