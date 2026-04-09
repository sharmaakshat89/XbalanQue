const trimTrailingSlash = (value) => value.replace(/\/+$/, '')

const defaultApiUrl = 'http://localhost:5000'
const configuredApiUrl = import.meta.env.VITE_API_URL || defaultApiUrl
const configuredSocketUrl = import.meta.env.VITE_SOCKET_URL || configuredApiUrl

export const API_URL = trimTrailingSlash(configuredApiUrl)
export const SOCKET_URL = trimTrailingSlash(configuredSocketUrl)
