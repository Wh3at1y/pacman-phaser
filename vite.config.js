import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
    server: {
      allowedHosts: [
          '21232a732af9.ngrok-free.app',
          '5255e0d73dfd.ngrok-free.app'
      ],
    }
})
