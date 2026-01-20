#!/bin/bash

# Скрипт для настройки Xvfb (виртуального дисплея) для robotjs на Linux сервере
# Использование: sudo ./setup-xvfb.sh

set -e

echo "🔧 Настройка Xvfb для robotjs..."

# Проверка прав root
if [ "$EUID" -ne 0 ]; then 
    echo "❌ Пожалуйста, запустите скрипт с правами root (sudo)"
    exit 1
fi

# Обновление пакетов
echo "📦 Обновление списка пакетов..."
apt-get update

# Установка Xvfb и необходимых пакетов
echo "📦 Установка Xvfb и зависимостей..."
apt-get install -y \
    xvfb \
    x11vnc \
    fluxbox \
    x11-utils \
    x11-xserver-utils \
    xfonts-base \
    xfonts-75dpi \
    xfonts-100dpi

# Создание systemd сервиса для Xvfb
echo "⚙️  Создание systemd сервиса для Xvfb..."
cat > /etc/systemd/system/xvfb.service << 'EOF'
[Unit]
Description=Virtual Framebuffer X Server for robotjs
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset
Restart=always
RestartSec=10
User=root

[Install]
WantedBy=multi-user.target
EOF

# Перезагрузка systemd и запуск сервиса
echo "🚀 Запуск Xvfb сервиса..."
systemctl daemon-reload
systemctl enable xvfb
systemctl start xvfb

# Проверка статуса
sleep 2
if systemctl is-active --quiet xvfb; then
    echo "✅ Xvfb успешно запущен!"
else
    echo "❌ Ошибка при запуске Xvfb"
    systemctl status xvfb
    exit 1
fi

# Создание файла для экспорта DISPLAY в .bashrc
echo "📝 Настройка переменной окружения DISPLAY..."
if ! grep -q "export DISPLAY=:99" /etc/environment; then
    echo "export DISPLAY=:99" >> /etc/environment
fi

# Создание скрипта для проверки
cat > /usr/local/bin/check-xvfb << 'EOF'
#!/bin/bash
export DISPLAY=:99
if xdpyinfo > /dev/null 2>&1; then
    echo "✅ Xvfb работает корректно"
    xdpyinfo | head -5
else
    echo "❌ Xvfb не работает"
    exit 1
fi
EOF

chmod +x /usr/local/bin/check-xvfb

echo ""
echo "✅ Настройка завершена!"
echo ""
echo "📋 Следующие шаги:"
echo "1. Перезагрузите сервер или выполните: source /etc/environment"
echo "2. Проверьте работу Xvfb: check-xvfb"
echo "3. В вашем приложении убедитесь, что DISPLAY=:99 установлен"
echo "4. Для PM2 добавьте в ecosystem.config.js: env: { DISPLAY: ':99' }"
echo ""
echo "🔍 Проверка статуса: systemctl status xvfb"
echo "📊 Просмотр логов: journalctl -u xvfb -f"


