# Настройка Windows Server для приложения

## Преимущества Windows Server для этого приложения

✅ **Не требует Xvfb** - нативный GUI уже есть  
✅ **robotjs работает "из коробки"** без дополнительных настроек  
✅ **RDP доступ** для визуального контроля и отладки  
✅ **Проще настройка** - не нужно настраивать виртуальный дисплей  
✅ **Меньше проблем** с разрешениями  
✅ **Удобная отладка** - можно видеть, что происходит на экране  

---

## Шаг 1: Установка Node.js

1. Скачайте Node.js 18.x или 20.x LTS с https://nodejs.org/
2. Запустите установщик
3. **Важно**: Отметьте опцию "Add to PATH"
4. Проверьте установку:
   ```powershell
   node --version
   npm --version
   ```

---

## Шаг 2: Установка Redis

### Вариант 1: Memurai (Redis для Windows) - Рекомендуется

1. Скачайте Memurai с https://www.memurai.com/
2. Установите Memurai (это Redis-совместимый сервер для Windows)
3. Запустите сервис:
   ```powershell
   # Memurai устанавливается как Windows Service и запускается автоматически
   ```

### Вариант 2: Redis в Docker Desktop

1. Установите Docker Desktop для Windows
2. Запустите Redis контейнер:
   ```powershell
   docker run -d -p 6379:6379 --name redis redis:latest
   ```

### Вариант 3: WSL2 с Redis

1. Установите WSL2 (Windows Subsystem for Linux)
2. Установите Redis в WSL2:
   ```bash
   sudo apt-get update
   sudo apt-get install redis-server
   sudo service redis-server start
   ```

---

## Шаг 3: Установка Visual Studio Build Tools

**Необходимо для компиляции robotjs**

1. Скачайте Build Tools: https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022
2. Запустите установщик
3. Выберите "Desktop development with C++"
4. Установите компоненты:
   - MSVC v143 - VS 2022 C++ x64/x86 build tools
   - Windows 10/11 SDK
   - C++ CMake tools for Windows

---

## Шаг 4: Установка PM2 для Windows

```powershell
# Установка PM2
npm install -g pm2

# Установка PM2 Windows Startup
npm install -g pm2-windows-startup

# Настройка автозапуска
pm2-startup install
```

---

## Шаг 5: Настройка RDP (Remote Desktop)

1. Откройте **Настройки** → **Система** → **Удаленный рабочий стол**
2. Включите **"Включить удаленный рабочий стол"**
3. Настройте firewall (обычно настраивается автоматически)
4. Для подключения используйте:
   - **IP адрес сервера**: `mstsc /v:IP_АДРЕС`
   - Или через Remote Desktop Connection

---

## Шаг 6: Установка и запуск приложения

### Клонирование/загрузка проекта:

```powershell
# Если проект в Git
git clone <repository-url>
cd test-app

# Или распакуйте архив проекта
```

### Установка зависимостей:

```powershell
npm install
```

**Примечание**: При установке `robotjs` может потребоваться компиляция. Убедитесь, что Visual Studio Build Tools установлены.

### Настройка переменных окружения:

Создайте файл `.env` в корне проекта:

```env
# Порт основного приложения
PORT=3000

# Порт сервиса мониторинга
MONITOR_PORT=3001

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# NCANode (если используется)
NCANODE_URL=ws://localhost:14579

# Сертификат (если используется)
CERT_PATH=C:\path\to\certificate.p12
CERT_PASSWORD=your_password

# Мониторинг объявлений
ANNOUNCE_MONITOR_ENABLED=true
ANNOUNCE_MONITOR_ID=15850002

# Другие настройки...
```

### Сборка проекта:

```powershell
npm run build
```

### Запуск с PM2:

```powershell
# Запуск основного сервиса
pm2 start dist/main.js --name "main-service"

# Запуск сервиса мониторинга
pm2 start dist/main-monitor.js --name "monitor-service"

# Просмотр статуса
pm2 status

# Просмотр логов
pm2 logs

# Сохранение конфигурации для автозапуска
pm2 save
```

### Альтернатива: Запуск через Task Scheduler

1. Откройте **Планировщик заданий** (Task Scheduler)
2. Создайте новое задание
3. Настройте запуск при старте системы
4. Команда: `node C:\path\to\project\dist\main.js`

---

## Шаг 7: Настройка Firewall

### Открыть порты для приложения:

```powershell
# Открыть порт 3000 (основной сервис)
New-NetFirewallRule -DisplayName "Main Service" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow

# Открыть порт 3001 (мониторинг)
New-NetFirewallRule -DisplayName "Monitor Service" -Direction Inbound -LocalPort 3001 -Protocol TCP -Action Allow

# Открыть порт 6379 (Redis)
New-NetFirewallRule -DisplayName "Redis" -Direction Inbound -LocalPort 6379 -Protocol TCP -Action Allow

# Открыть порт 3389 (RDP) - если еще не открыт
New-NetFirewallRule -DisplayName "Remote Desktop" -Direction Inbound -LocalPort 3389 -Protocol TCP -Action Allow
```

---

## Шаг 8: Проверка работы

### Проверка Node.js процессов:

```powershell
pm2 status
pm2 logs
```

### Проверка Redis:

```powershell
# Если используется Memurai или Redis в Docker
# Проверьте, что сервис запущен
Get-Service | Where-Object {$_.Name -like "*redis*" -or $_.Name -like "*memurai*"}
```

### Проверка портов:

```powershell
netstat -an | findstr "3000 3001 6379"
```

### Проверка robotjs:

```powershell
# Запустите тестовый скрипт (если есть)
npm test
```

---

## Устранение проблем

### Проблема: robotjs не компилируется

**Решение:**
1. Убедитесь, что установлены Visual Studio Build Tools
2. Переустановите robotjs:
   ```powershell
   npm uninstall robotjs
   npm install robotjs --build-from-source
   ```

### Проблема: PM2 не запускается при старте системы

**Решение:**
```powershell
pm2-startup install
pm2 save
```

### Проблема: Redis не запускается

**Решение:**
- Для Memurai: Проверьте сервис в Services (services.msc)
- Для Docker: Проверьте, что Docker Desktop запущен
- Для WSL2: Запустите Redis вручную в WSL2

### Проблема: RDP не работает

**Решение:**
1. Проверьте, что Remote Desktop включен в настройках
2. Проверьте firewall правила
3. Убедитесь, что порт 3389 открыт

---

## Рекомендации по безопасности

1. **Измените пароль администратора** на сложный
2. **Настройте Windows Firewall** - откройте только необходимые порты
3. **Используйте RDP через VPN** (если возможно)
4. **Регулярно обновляйте Windows** и установленное ПО
5. **Используйте антивирус** (Windows Defender обычно достаточно)
6. **Настройте автоматические бэкапы** важных данных

---

## Мониторинг и обслуживание

### Просмотр логов:

```powershell
# PM2 логи
pm2 logs

# Логи конкретного процесса
pm2 logs main-service
pm2 logs monitor-service

# Очистка логов
pm2 flush
```

### Мониторинг ресурсов:

```powershell
# PM2 мониторинг
pm2 monit

# Системный мониторинг
Get-Process | Sort-Object CPU -Descending | Select-Object -First 10
```

### Перезапуск сервисов:

```powershell
pm2 restart all
pm2 restart main-service
pm2 restart monitor-service
```

---

## Итоговая проверка

После настройки проверьте:

- [ ] Node.js установлен и работает
- [ ] Redis запущен и доступен
- [ ] Приложение собрано (`npm run build`)
- [ ] PM2 запускает оба сервиса
- [ ] Порты 3000 и 3001 открыты
- [ ] RDP доступ работает
- [ ] robotjs работает (можно протестировать)
- [ ] PM2 настроен на автозапуск

---

## Полезные команды

```powershell
# Просмотр всех процессов PM2
pm2 list

# Перезапуск всех процессов
pm2 restart all

# Остановка всех процессов
pm2 stop all

# Удаление процессов из PM2
pm2 delete all

# Просмотр использования ресурсов
pm2 monit

# Экспорт конфигурации
pm2 save

# Просмотр информации о процессе
pm2 describe main-service
```


