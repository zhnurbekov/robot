#!/bin/bash

echo "=== Проверка разрешений для robotjs на macOS ==="
echo ""

# Проверка, что мы на macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
    echo "Этот скрипт предназначен только для macOS"
    exit 0
fi

echo "Для работы robotjs на macOS необходимо предоставить разрешения:"
echo ""
echo "1. Системные настройки → Конфиденциальность и безопасность → Управление компьютером"
echo "   ✓ Разрешить доступ для Terminal (или ваш терминал/IDE)"
echo ""
echo "2. Системные настройки → Конфиденциальность и безопасность → Доступность"
echo "   ✓ Разрешить доступ для Terminal (или ваш терминал/IDE)"
echo ""
echo "Как проверить:"
echo "1. Откройте 'Системные настройки' (System Settings)"
echo "2. Перейдите в 'Конфиденциальность и безопасность' (Privacy & Security)"
echo "3. Найдите 'Управление компьютером' (Full Disk Access) и добавьте ваш терминал"
echo "4. Найдите 'Доступность' (Accessibility) и добавьте ваш терминал"
echo ""
echo "После добавления разрешений перезапустите терминал/IDE и попробуйте снова."
echo ""

# Попытка проверить, работает ли robotjs
echo "Проверка работы robotjs..."
if command -v node &> /dev/null; then
    cd "$(dirname "$0")"
    node -e "
        import('robotjs').then(r => {
            const pos = r.default.getMousePos();
            console.log('Текущая позиция мыши:', pos);
            r.default.moveMouse(pos.x + 10, pos.y + 10);
            setTimeout(() => {
                const newPos = r.default.getMousePos();
                if (Math.abs(newPos.x - (pos.x + 10)) < 5 && Math.abs(newPos.y - (pos.y + 10)) < 5) {
                    console.log('✓ Мышь двигается! Разрешения настроены правильно.');
                } else {
                    console.log('✗ Мышь не двигается. Нужны разрешения в настройках macOS.');
                    console.log('  См. инструкции выше.');
                }
            }, 100);
        }).catch(e => {
            console.error('✗ Ошибка:', e.message);
        });
    " 2>&1
else
    echo "✗ Node.js не найден"
fi





