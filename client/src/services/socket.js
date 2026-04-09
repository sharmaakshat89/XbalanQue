import { io } from 'socket.io-client';
import { SOCKET_URL } from '@/config';

const DEFAULT_SESSION_ID = 'default-session';

export const socket = io(SOCKET_URL, {
  autoConnect: false,
  reconnection: true,
  pingTimeout: 60000,
});

export const getSessionId = () => {
  const storedSessionId = localStorage.getItem('sessionId');

  if (storedSessionId) {
    return storedSessionId;
  }

  localStorage.setItem('sessionId', DEFAULT_SESSION_ID);
  return DEFAULT_SESSION_ID;
};

export const connectSocket = () => {
  const token = localStorage.getItem('token');

  socket.auth = {
    token,
    sessionId: getSessionId()
  };

  if (!socket.connected) {
    socket.connect();
  }
};

export const disconnectSocket = () => {
  if (socket.connected) {
    socket.disconnect();
  }
};
