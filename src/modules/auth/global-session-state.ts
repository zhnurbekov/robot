// Глобальная переменная для хранения состояния сессии и авторизации
// Доступна из любого места приложения для быстрой проверки без запросов к сервисам
export const globalSessionState = {
  isAuthenticated: false,
  sessionToken: null as string | null,
  lastAuthTime: null as number | null,
  cookies: [] as string[],
  isValid: false,
};

