FROM node:20-slim

# Chrome, Xvfb සහ D-Bus සඳහා අවශ්‍ය Linux dependencies install කිරීම
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    procps \
    libxss1 \
    xvfb \
    xauth \
    dbus \
    dbus-x11 \
    libgbm-dev \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgcc1 \
    libgdk-pixbuf2.0-0 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxtst6 \
    fonts-liberation \
    libnss3 \
    lsb-release \
    xdg-utils \
    --no-install-recommends

# Google Chrome Stable install කිරීම
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg \
    && sh -c 'echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# /etc/machine-id ජනනය කිරීම සහ D-Bus / X11 directories සැකසීම
RUN dbus-uuidgen > /etc/machine-id \
    && mkdir -p /var/run/dbus /tmp/.X11-unix \
    && chmod 1777 /tmp/.X11-unix

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

ENV DISPLAY=:99
ENV DBUS_SESSION_BUS_ADDRESS=unix:path=/var/run/dbus/system_bus_socket
EXPOSE 3000

# D-Bus, Xvfb සහ Node server එක පිළිවෙලින් ආරම්භ කිරීම
CMD ["sh", "-c", "dbus-daemon --system --fork && Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset & sleep 1 && node index.js"]
