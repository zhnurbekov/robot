/**
 * Интерфейс для хранения сессии
 */
export interface ISessionStorage {
  /**
   * Сохранить сессию
   */
  saveSession(sessionData: SessionData): Promise<void>;

  /**
   * Загрузить сессию
   */
  loadSession(): Promise<SessionData | null>;

  /**
   * Очистить сессию
   */
  clearSession(): Promise<void>;

  /**
   * Проверить валидность сессии
   */
  isSessionValid(sessionData: SessionData): boolean;
}

/**
 * Данные сессии
 */
export interface SessionData {
  token?: string | null;
  cookies?: string[];
  expiresAt?: number; // timestamp
  createdAt: number; // timestamp
  updatedAt?: number; // timestamp
  isAuthenticated: boolean;
}


