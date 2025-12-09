# Инструкция по установке robotjs

## Проблема
robotjs требует нативной компиляции и Python 3.6+ для сборки.

## Быстрая диагностика

Запустите скрипт диагностики:
```bash
./check-dependencies.sh
```

Этот скрипт проверит все необходимые зависимости и покажет, что нужно исправить.

## Решение

### Шаг 1: Принять лицензию Xcode ⚠️ ОБЯЗАТЕЛЬНО

**Это самый важный шаг!** Без принятия лицензии Xcode Python 3 не сможет работать.

Выполните в терминале:
```bash
sudo xcodebuild -license
```

**Инструкция:**
1. Введите пароль администратора
2. Нажмите **пробел** несколько раз, чтобы прокрутить лицензию до конца
3. Введите `agree` и нажмите Enter
4. Если появится запрос подтверждения, введите `agree` еще раз

**Проверка:**
После принятия лицензии проверьте:
```bash
python3 --version
```
Должна отобразиться версия Python (например, `Python 3.9.6`), а не сообщение о лицензии.

### Шаг 2: Установить Xcode Command Line Tools (если еще не установлены)
```bash
xcode-select --install
```

### Шаг 3: Проверить Python 3
```bash
python3 --version
```
Должна быть версия 3.6 или выше.

### Шаг 4: Установить robotjs с указанием Python
```bash
cd /Users/zh.nurbekov/WebstormProjects/test-app
npm install robotjs --python=/usr/bin/python3
```

Или через переменную окружения:
```bash
export PYTHON=/usr/bin/python3
npm install robotjs
```

### Альтернатива: Использовать Homebrew для установки Python
Если Python 3 не работает, установите через Homebrew:
```bash
brew install python3
```
Затем используйте путь к установленному Python:
```bash
npm install robotjs --python=$(which python3)
```

## Если проблемы продолжаются

Попробуйте установить зависимости для компиляции:
```bash
# Установить через Homebrew (если установлен)
brew install python3

# Или установить через официальный установщик Python
# Скачайте с https://www.python.org/downloads/
```

