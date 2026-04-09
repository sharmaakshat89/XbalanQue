import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login';
import Receiver from './pages/Receiver';
import Transmitter from './pages/Transmitter';

function PrivateRoute({ children, allowedRole }) {
  const token = localStorage.getItem('token');
  const role = localStorage.getItem('role');
  
  if (!token) {
    return <Navigate to="/" />;
  }
  
  if (allowedRole && role !== allowedRole) {
    return <Navigate to="/" />;
  }
  
  return children;
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Login />} />
        <Route 
          path="/receiver" 
          element={
            <PrivateRoute allowedRole="receiver">
              <Receiver />
            </PrivateRoute>
          } 
        />
        <Route 
          path="/transmitter" 
          element={
            <PrivateRoute allowedRole="transmitter">
              <Transmitter />
            </PrivateRoute>
          } 
        />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
