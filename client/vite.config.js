import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://4752002db531.ngrok-free.app -> http://localhost:5177
// Forwarding                    https://61d146f9505b.ngrok-free.app -> http://localhost:5173

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
    server: {
      allowedHosts: [
          '61d146f9505b.ngrok-free.app',
          '4752002db531.ngrok-free.app'
      ],
    }
})


