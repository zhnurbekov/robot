#!/bin/bash

echo "=========================================="
echo "Исправление проблем установки robotjs"
echo "=========================================="
echo ""

# Шаг 1: Проверка и принятие лицензии Xcode
echo "Шаг 1: Проверка лицензии Xcode..."
if xcodebuild -license check 2>&1 | grep -q "license"; then
    echo "⚠️  Требуется принять лицензию Xcode"
    echo ""
    echo "Выполните следующую команду в терминале:"
    echo "  sudo xcodebuild -license"
    echo ""
    echo "После выполнения команды:"
    echo "  1. Прокрутите до конца лицензии (нажимайте пробел)"
    echo "  2. Введите 'agree' и нажмите Enter"
    echo ""
    read -p "Нажмите Enter после принятия лицензии, или Ctrl+C для отмены..."
else
    echo "✓ Лицензия Xcode принята"
fi

echo ""

# Шаг 2: Проверка Python
echo "Шаг 2: Проверка Python 3..."
if command -v python3 &> /dev/null; then
    PYTHON_PATH=$(which python3)
    PYTHON_VERSION=$(python3 --version 2>&1)
    echo "✓ Найден: $PYTHON_VERSION"
    echo "  Путь: $PYTHON_PATH"
else
    echo "✗ Python 3 не найден"
    echo ""
    echo "Установите Python 3 одним из способов:"
    echo "  1. Через Homebrew: brew install python3"
    echo "  2. Скачайте с https://www.python.org/downloads/"
    exit 1
fi

echo ""

# Шаг 3: Установка robotjs
echo "Шаг 3: Установка robotjs..."
export PYTHON="$PYTHON_PATH"
npm install robotjs --python="$PYTHON_PATH"

if [ $? -eq 0 ]; then
    echo ""
    echo "=========================================="
    echo "✓ robotjs успешно установлен!"
    echo "=========================================="
else
    echo ""
    echo "=========================================="
    echo "✗ Ошибка при установке"
    echo "=========================================="
    echo ""
    echo "Попробуйте следующие шаги:"
    echo ""
    echo "1. Убедитесь, что лицензия Xcode принята:"
    echo "   sudo xcodebuild -license"
    echo ""
    echo "2. Установите Xcode Command Line Tools:"
    echo "   xcode-select --install"
    echo ""
    echo "3. Установите Python 3 через Homebrew:"
    echo "   brew install python3"
    echo ""
    echo "4. Попробуйте установить снова:"
    echo "   npm install robotjs --python=\$(which python3)"
    exit 1
fi

