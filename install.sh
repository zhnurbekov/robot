#!/bin/bash

# Скрипт установки robotjs с проверкой зависимостей

echo "=== Установка robotjs ==="
echo ""

# Проверка Python 3
echo "Проверка Python 3..."
if command -v python3 &> /dev/null; then
    PYTHON_VERSION=$(python3 --version 2>&1)
    echo "✓ Найден: $PYTHON_VERSION"
    PYTHON_PATH=$(which python3)
    echo "  Путь: $PYTHON_PATH"
else
    echo "✗ Python 3 не найден"
    echo "Установите Python 3:"
    echo "  brew install python3"
    echo "  или скачайте с https://www.python.org/downloads/"
    exit 1
fi

# Проверка версии Python
PYTHON_MAJOR=$(python3 -c 'import sys; print(sys.version_info.major)')
PYTHON_MINOR=$(python3 -c 'import sys; print(sys.version_info.minor)')

if [ "$PYTHON_MAJOR" -lt 3 ] || ([ "$PYTHON_MAJOR" -eq 3 ] && [ "$PYTHON_MINOR" -lt 6 ]); then
    echo "✗ Требуется Python 3.6+, найден Python $PYTHON_MAJOR.$PYTHON_MINOR"
    exit 1
fi

echo "✓ Версия Python подходит"
echo ""

# Проверка Xcode Command Line Tools
echo "Проверка Xcode Command Line Tools..."
if xcode-select -p &> /dev/null; then
    echo "✓ Xcode Command Line Tools установлены"
else
    echo "✗ Xcode Command Line Tools не установлены"
    echo "Установите выполнив: xcode-select --install"
    exit 1
fi

echo ""

# Установка robotjs
echo "Установка robotjs..."
export PYTHON="$PYTHON_PATH"
npm install robotjs --python="$PYTHON_PATH"

if [ $? -eq 0 ]; then
    echo ""
    echo "✓ robotjs успешно установлен!"
else
    echo ""
    echo "✗ Ошибка при установке robotjs"
    echo ""
    echo "Попробуйте:"
    echo "1. Принять лицензию Xcode: sudo xcodebuild -license"
    echo "2. Установить зависимости: brew install python3"
    echo "3. Запустить установку снова: npm install robotjs --python=\$(which python3)"
    exit 1
fi



