#!/bin/bash

echo "=== Диагностика зависимостей для установки robotjs ==="
echo ""

ERRORS=0

# Проверка лицензии Xcode
echo "1. Проверка лицензии Xcode..."
if xcodebuild -license check 2>&1 | grep -q "license"; then
    echo "   ✗ Лицензия Xcode не принята"
    echo "   → Выполните: sudo xcodebuild -license"
    echo "   → Прокрутите до конца (пробел) и введите 'agree'"
    ERRORS=$((ERRORS + 1))
else
    echo "   ✓ Лицензия Xcode принята"
fi
echo ""

# Проверка Xcode Command Line Tools
echo "2. Проверка Xcode Command Line Tools..."
if xcode-select -p &> /dev/null; then
    echo "   ✓ Xcode Command Line Tools установлены"
    XCODE_PATH=$(xcode-select -p)
    echo "   Путь: $XCODE_PATH"
else
    echo "   ✗ Xcode Command Line Tools не установлены"
    echo "   → Выполните: xcode-select --install"
    ERRORS=$((ERRORS + 1))
fi
echo ""

# Проверка Python 3
echo "3. Проверка Python 3..."
if command -v python3 &> /dev/null; then
    PYTHON_PATH=$(which python3)
    echo "   ✓ Python 3 найден: $PYTHON_PATH"
    
    # Попытка получить версию
    PYTHON_VERSION=$(python3 --version 2>&1)
    if echo "$PYTHON_VERSION" | grep -q "license"; then
        echo "   ✗ Python 3 не может выполниться (лицензия Xcode не принята)"
        ERRORS=$((ERRORS + 1))
    else
        echo "   Версия: $PYTHON_VERSION"
        
        # Проверка версии
        PYTHON_MAJOR=$(python3 -c 'import sys; print(sys.version_info.major)' 2>/dev/null)
        PYTHON_MINOR=$(python3 -c 'import sys; print(sys.version_info.minor)' 2>/dev/null)
        
        if [ -n "$PYTHON_MAJOR" ] && [ -n "$PYTHON_MINOR" ]; then
            if [ "$PYTHON_MAJOR" -ge 3 ] && [ "$PYTHON_MINOR" -ge 6 ]; then
                echo "   ✓ Версия Python подходит (>= 3.6)"
            else
                echo "   ✗ Версия Python слишком старая (требуется >= 3.6)"
                ERRORS=$((ERRORS + 1))
            fi
        fi
    fi
else
    echo "   ✗ Python 3 не найден"
    echo "   → Установите через: brew install python3"
    ERRORS=$((ERRORS + 1))
fi
echo ""

# Проверка Node.js
echo "4. Проверка Node.js..."
if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version)
    echo "   ✓ Node.js установлен: $NODE_VERSION"
else
    echo "   ✗ Node.js не найден"
    ERRORS=$((ERRORS + 1))
fi
echo ""

# Проверка npm
echo "5. Проверка npm..."
if command -v npm &> /dev/null; then
    NPM_VERSION=$(npm --version)
    echo "   ✓ npm установлен: $NPM_VERSION"
else
    echo "   ✗ npm не найден"
    ERRORS=$((ERRORS + 1))
fi
echo ""

# Итоги
echo "=== Итоги ==="
if [ $ERRORS -eq 0 ]; then
    echo "✓ Все зависимости установлены!"
    echo ""
    echo "Можно устанавливать robotjs:"
    echo "  npm install robotjs --python=$PYTHON_PATH"
    echo ""
    echo "Или используйте автоматический скрипт:"
    echo "  ./install.sh"
else
    echo "✗ Найдено проблем: $ERRORS"
    echo ""
    echo "Исправьте проблемы выше и запустите проверку снова:"
    echo "  ./check-dependencies.sh"
fi

exit $ERRORS

