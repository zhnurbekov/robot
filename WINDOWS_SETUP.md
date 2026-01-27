# Настройка для Windows Server

## Проблема с robotjs на Windows

`robotjs` требует компиляции нативных модулей на Windows Server. Для этого необходимо установить Visual Studio Build Tools.

## Установка на Windows Server

### 1. Установка Node.js 16

Скачайте и установите Node.js 16.x с официального сайта:
https://nodejs.org/download/release/v16.20.2/

### 2. Установка Visual Studio Build Tools (для robotjs, если нужен fallback)

Если вы хотите использовать robotjs как резервный вариант:

1. Скачайте Visual Studio Build Tools: https://visualstudio.microsoft.com/downloads/
2. При установке выберите:
   - **Desktop development with C++**
   - **Windows 10/11 SDK**
   - **Python development** (опционально)

### 3. Установка зависимостей проекта

```powershell
# Установите yarn (если еще не установлен)
npm install -g yarn

# Перейдите в директорию проекта
cd C:\path\to\your\project

# Установите зависимости
yarn install
```

### 4. Пересборка robotjs

После установки Build Tools необходимо пересобрать robotjs:

```powershell
# Пересоберите robotjs через npm (yarn не поддерживает rebuild напрямую)
npm rebuild robotjs

# Или используйте скрипт из package.json
yarn rebuild:robotjs
```

### 5. Проверка работы

Запустите приложение:

```powershell
yarn start:dev
```

В логах вы должны увидеть:
```
[InputAdapterService] Используется robotjs на платформе: win32
```

### 6. Если возникают проблемы

#### Проблема: "robotjs не может быть загружен"

**Решение:**
1. Убедитесь, что установлены Visual Studio Build Tools с компонентом "Desktop development with C++"
2. Убедитесь, что установлен Windows SDK
3. Пересоберите robotjs:
```powershell
npm rebuild robotjs --build-from-source
```

#### Проблема: Ошибка компиляции при установке

**Решение:**
1. Установите Python 2.7 или 3.x (для node-gyp):
   - Скачайте с https://www.python.org/downloads/
   - При установке отметьте "Add Python to PATH"

2. Настройте переменные окружения:
```powershell
# Установите путь к Python
$env:PYTHON = "C:\Python27\python.exe"  # или путь к Python 3.x

# Установите путь к Visual Studio
$env:GYP_MSVS_VERSION = "2022"  # или ваша версия VS
```

3. Переустановите robotjs:
```powershell
# Через npm
npm uninstall robotjs
npm install robotjs --build-from-source

# Или через yarn
yarn remove robotjs
yarn add robotjs
npm rebuild robotjs
```

#### Проблема: "file-type requires Node.js >=18"

**Решение:**
Эта ошибка возникает из-за зависимости `open`. Версия `open@10.x` требует Node.js 18+. 
В проекте используется `open@8.4.2`, которая совместима с Node.js 16.

Если ошибка все еще возникает:
```powershell
# Удалите node_modules и yarn.lock
Remove-Item -Recurse -Force node_modules
Remove-Item yarn.lock

# Переустановите зависимости
yarn install
```

#### Проблема: "Module was compiled against a different Node.js version"

**Решение:**
```powershell
# Пересоберите все нативные модули
npm rebuild
```

## Альтернативные решения

Если robotjs не работает, можно использовать:

1. **Puppeteer** - для автоматизации браузера (если работаете с веб-интерфейсом)
2. **PowerShell скрипты** - для простых операций через `child_process`
3. **Windows API через ffi-napi** - для прямого доступа к Windows API

## Альтернативные решения

Если ни одна библиотека не работает, можно использовать:

1. **Puppeteer** - для автоматизации браузера (если работаете с веб-интерфейсом)
2. **PowerShell скрипты** - для простых операций через `child_process`
3. **Windows API через ffi-napi** - для прямого доступа к Windows API

## Проверка установки

После установки запустите приложение:

```powershell
yarn start:dev
```

В логах вы должны увидеть:
```
[InputAdapterService] Используется @nut-tree/nut-js для Windows
```

Если видите предупреждение о fallback на robotjs, это нормально - адаптер автоматически выберет рабочую библиотеку.
