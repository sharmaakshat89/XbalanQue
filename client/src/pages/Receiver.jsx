import { useState, useEffect } from 'react'
import { Camera, Mic, Loader2, LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { socket, connectSocket } from '@/services/socket'

function Receiver() {
  const [status, setStatus] = useState('idle')
  const [result, setResult] = useState(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    connectSocket()

    const handleCaptureStarted = () => {
      setStatus('capturing')
      setIsLoading(true)
      setError('')
    }

    const handleProcessingStarted = () => {
      setStatus('processing')
      setIsLoading(true)
      setError('')
    }

    const handleResult = (data) => {
      setResult(data)
      setIsLoading(false)
      setStatus('idle')
      setError('')
    }

    const handleFailure = (payload) => {
      setIsLoading(false)
      setStatus('error')
      setError(payload?.error || 'Request failed')
    }

    socket.on('capture_started', handleCaptureStarted)
    socket.on('processing_started', handleProcessingStarted)
    socket.on('result', handleResult)
    socket.on('processing_failed', handleFailure)
    socket.on('connect_error', handleFailure)

    return () => {
      socket.off('capture_started', handleCaptureStarted)
      socket.off('processing_started', handleProcessingStarted)
      socket.off('result', handleResult)
      socket.off('processing_failed', handleFailure)
      socket.off('connect_error', handleFailure)
    }
  }, [])

  const startRemoteAction = (eventName) => {
    setError('')
    setStatus('requesting')
    setIsLoading(true)
    setResult(null)
    socket.emit(eventName)
  }

  const handleCaptureImage = () => {
    startRemoteAction('trigger_capture')
  }

  const handleRecordAudio = () => {
    startRemoteAction('trigger_audio')
  }

  const handleLogout = () => {
    localStorage.removeItem('token')
    localStorage.removeItem('role')
    window.location.href = '/'
  }

  return (
    <div className="min-h-screen bg-background relative">
      <div
        className="absolute top-3 right-3 text-xs opacity-20 tracking-widest"
        style={{ fontFamily: '"Courier New", Courier, monospace' }}
      >
        XbalanQue
      </div>
      <header className="border-b bg-card sticky top-0 z-10">
        <div className="flex items-center justify-between px-4 py-4 max-w-md mx-auto">
          <h1 className="text-lg font-semibold">Dashboard</h1>
          <Button variant="ghost" size="icon" onClick={handleLogout}>
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <main className="p-4 space-y-4">
        <Card className="max-w-md mx-auto">
          <CardHeader className="space-y-1">
            <CardTitle className="text-xl font-semibold">Capture Controls</CardTitle>
            <CardDescription>Request media capture from the transmitter</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button
              size="xl"
              className="w-full h-14"
              onClick={handleCaptureImage}
              disabled={isLoading}
            >
              {isLoading ? (
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              ) : (
                <Camera className="mr-2 h-5 w-5" />
              )}
              Capture Image
            </Button>

            <Button
              size="xl"
              className="w-full h-14"
              onClick={handleRecordAudio}
              disabled={isLoading}
            >
              {isLoading ? (
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              ) : (
                <Mic className="mr-2 h-5 w-5" />
              )}
              Record Audio
            </Button>

            <div className="flex items-center justify-between pt-4 border-t">
              <span className="text-sm text-muted-foreground">Status</span>
              <span className="text-sm font-medium capitalize">{status}</span>
            </div>
          </CardContent>
        </Card>

        {error && (
          <Card className="max-w-md mx-auto border-destructive/30">
            <CardContent className="py-4 text-sm text-destructive">
              {error}
            </CardContent>
          </Card>
        )}

        {isLoading && (
          <Card className="max-w-md mx-auto">
            <CardContent className="flex items-center gap-3 py-4">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-sm">Processing with AI...</span>
            </CardContent>
          </Card>
        )}

        {result && (
          <Card className="max-w-md mx-auto">
            <CardHeader className="space-y-1">
              <CardTitle>Result</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <p className="text-sm text-muted-foreground">Question</p>
                <p className="font-medium">{result.question}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Answer</p>
                <p className="font-semibold text-lg">{result.answer}</p>
              </div>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  )
}

export default Receiver
