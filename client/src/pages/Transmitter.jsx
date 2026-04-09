import { useEffect, useRef, useState, useCallback } from 'react'
import Webcam from 'react-webcam'
import { Mic, MicOff, Loader2, LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { API_URL } from '@/config'
import { connectSocket, socket } from '@/services/socket'

function Transmitter() {
  const webcamRef = useRef(null)
  const [status, setStatus] = useState('idle')
  const [isRecording, setIsRecording] = useState(false)
  const [streamActive, setStreamActive] = useState(false)
  const [error, setError] = useState('')
  const activeRequestRef = useRef(null)
  const audioContextRef = useRef(null)
  const mediaStreamRef = useRef(null)
  const processorRef = useRef(null)
  const gainNodeRef = useRef(null)
  const recordingTimeoutRef = useRef(null)
  const audioChunksRef = useRef([])

  const createWavBlob = useCallback((audioChunks, sampleRate) => {
    const totalLength = audioChunks.reduce((sum, chunk) => sum + chunk.length, 0)
    const mergedSamples = new Float32Array(totalLength)
    let offset = 0

    audioChunks.forEach((chunk) => {
      mergedSamples.set(chunk, offset)
      offset += chunk.length
    })

    const pcmBuffer = new ArrayBuffer(44 + mergedSamples.length * 2)
    const view = new DataView(pcmBuffer)

    const writeString = (position, value) => {
      for (let index = 0; index < value.length; index += 1) {
        view.setUint8(position + index, value.charCodeAt(index))
      }
    }

    writeString(0, 'RIFF')
    view.setUint32(4, 36 + mergedSamples.length * 2, true)
    writeString(8, 'WAVE')
    writeString(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * 2, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    writeString(36, 'data')
    view.setUint32(40, mergedSamples.length * 2, true)

    let dataOffset = 44
    for (let index = 0; index < mergedSamples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, mergedSamples[index]))
      view.setInt16(dataOffset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      dataOffset += 2
    }

    return new Blob([view], { type: 'audio/wav' })
  }, [])

  const cleanupAudioRecording = useCallback(() => {
    if (recordingTimeoutRef.current) {
      clearTimeout(recordingTimeoutRef.current)
      recordingTimeoutRef.current = null
    }

    if (processorRef.current) {
      processorRef.current.disconnect()
      processorRef.current.onaudioprocess = null
      processorRef.current = null
    }

    if (gainNodeRef.current) {
      gainNodeRef.current.disconnect()
      gainNodeRef.current = null
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop())
      mediaStreamRef.current = null
    }

    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {})
      audioContextRef.current = null
    }

    setIsRecording(false)
    setStreamActive(false)
  }, [])

  const sendToBackend = useCallback(async (endpoint, file, fieldName, requestId) => {
    const token = localStorage.getItem('token')
    const formData = new FormData()
    formData.append(fieldName, file)
    formData.append('requestId', requestId)

    try {
      setStatus('Processing')
      setError('')

      const response = await fetch(`${API_URL}${endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`
        },
        body: formData
      })

      const result = await response.json()

      if (!response.ok) {
        throw new Error(result.error || 'Backend processing failed')
      }

      if (result.text) {
        socket.emit('process_text', { requestId, text: result.text })
      }
    } catch (requestError) {
      console.error('Error sending to backend:', requestError)
      setStatus('idle')
      setError(requestError.message)
      socket.emit('capture_failed', {
        requestId,
        error: requestError.message
      })
      activeRequestRef.current = null
    }
  }, [])

  const captureImage = useCallback(async ({ requestId }) => {
    if (!webcamRef.current || activeRequestRef.current) {
      if (requestId) {
        socket.emit('capture_failed', {
          requestId,
          error: 'Transmitter is busy'
        })
      }
      return
    }

    activeRequestRef.current = requestId
    setStatus('Capturing')
    setError('')

    const imageSrc = webcamRef.current.getScreenshot()
    if (!imageSrc) {
      socket.emit('capture_failed', {
        requestId,
        error: 'Camera is not ready'
      })
      setStatus('idle')
      activeRequestRef.current = null
      return
    }

    const imageResponse = await fetch(imageSrc)
    const imageBlob = await imageResponse.blob()
    const imageFile = new File([imageBlob], `capture-${requestId}.jpg`, {
      type: 'image/jpeg'
    })

    await sendToBackend('/api/upload', imageFile, 'image', requestId)
  }, [sendToBackend])

  const startAudioRecording = useCallback(({ requestId }) => {
    if (activeRequestRef.current) {
      socket.emit('capture_failed', {
        requestId,
        error: 'Transmitter is busy'
      })
      return
    }

    activeRequestRef.current = requestId
    setStatus('Recording')
    setIsRecording(true)
    setError('')
    audioChunksRef.current = []

    navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        noiseSuppression: true,
        echoCancellation: true,
        sampleRate: 16000
      }
    })
      .then((mediaStream) => {
        setStreamActive(true)
        mediaStreamRef.current = mediaStream

        const audioContext = new window.AudioContext({ sampleRate: 16000 })
        audioContextRef.current = audioContext
        const source = audioContext.createMediaStreamSource(mediaStream)
        const processor = audioContext.createScriptProcessor(4096, 1, 1)
        const gainNode = audioContext.createGain()
        gainNode.gain.value = 0

        processorRef.current = processor
        gainNodeRef.current = gainNode

        processor.onaudioprocess = (event) => {
          const inputData = event.inputBuffer.getChannelData(0)
          audioChunksRef.current.push(new Float32Array(inputData))
        }

        source.connect(processor)
        processor.connect(gainNode)
        gainNode.connect(audioContext.destination)

        recordingTimeoutRef.current = setTimeout(async () => {
          try {
            const wavBlob = createWavBlob(audioChunksRef.current, audioContext.sampleRate)
            const audioFile = new File([wavBlob], `audio-${requestId}.wav`, {
              type: 'audio/wav'
            })
            await sendToBackend('/api/audio', audioFile, 'audio', requestId)
          } catch (recordingError) {
            console.error('Audio recording failed:', recordingError)
            setStatus('idle')
            setError(recordingError.message)
            socket.emit('capture_failed', {
              requestId,
              error: recordingError.message || 'Audio recording failed'
            })
            activeRequestRef.current = null
          } finally {
            cleanupAudioRecording()
          }
        }, 50000)
      })
      .catch((mediaError) => {
        console.error('Error accessing microphone:', mediaError)
        setStatus('idle')
        cleanupAudioRecording()
        setError('Microphone access denied')
        socket.emit('capture_failed', {
          requestId,
          error: 'Microphone access denied'
        })
        activeRequestRef.current = null
      })
  }, [cleanupAudioRecording, createWavBlob, sendToBackend])

  useEffect(() => {
    connectSocket()

    const handleCapture = (payload) => {
      captureImage(payload)
    }

    const handleAudio = (payload) => {
      startAudioRecording(payload)
    }

    const handleRequestComplete = ({ requestId }) => {
      if (activeRequestRef.current === requestId) {
        activeRequestRef.current = null
        setStatus('idle')
        cleanupAudioRecording()
      }
    }

    const handleFailure = ({ requestId, error: message }) => {
      if (!requestId || activeRequestRef.current === requestId) {
        activeRequestRef.current = null
        setStatus('idle')
        cleanupAudioRecording()
        setError(message || 'Request failed')
      }
    }

    socket.on('do_capture', handleCapture)
    socket.on('do_audio', handleAudio)
    socket.on('request_complete', handleRequestComplete)
    socket.on('processing_failed', handleFailure)

    return () => {
      socket.off('do_capture', handleCapture)
      socket.off('do_audio', handleAudio)
      socket.off('request_complete', handleRequestComplete)
      socket.off('processing_failed', handleFailure)
    }
  }, [captureImage, cleanupAudioRecording, startAudioRecording])

  useEffect(() => {
    return () => {
      cleanupAudioRecording()
    }
  }, [cleanupAudioRecording])

  const handleLogout = () => {
    localStorage.removeItem('token')
    localStorage.removeItem('role')
    window.location.href = '/'
  }

  const getStatusColor = () => {
    switch (status) {
      case 'Capturing':
      case 'Recording':
        return 'text-orange-600'
      case 'Processing':
        return 'text-blue-600'
      default:
        return 'text-muted-foreground'
    }
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
          <h1 className="text-lg font-semibold">Transmitter</h1>
          <Button variant="ghost" size="icon" onClick={handleLogout}>
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <main className="p-4 space-y-4">
        <Card className="max-w-md mx-auto">
          <CardHeader className="space-y-1">
            <CardTitle className="text-xl font-semibold">Camera Feed</CardTitle>
            <CardDescription>Waiting for receiver-triggered capture commands</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="relative aspect-[4/3] bg-muted rounded-lg overflow-hidden">
              <Webcam
                ref={webcamRef}
                audio={false}
                screenshotFormat="image/jpeg"
                videoConstraints={{ facingMode: 'environment' }}
                className="absolute inset-0 w-full h-full object-cover"
              />
              {isRecording && (
                <div className="absolute top-3 right-3 flex items-center gap-2 bg-destructive text-destructive-foreground px-3 py-1.5 rounded-full text-sm font-medium">
                  <Mic className="h-4 w-4 animate-pulse" />
                  Recording
                </div>
              )}
            </div>

            <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
              Capture stays locked to remote socket commands from the paired receiver.
            </div>

            <div className="flex items-center justify-between pt-2 border-t">
              <span className="text-sm text-muted-foreground">Status</span>
              <div className="flex items-center gap-2">
                {status !== 'idle' && <Loader2 className="h-4 w-4 animate-spin" />}
                <span className={`text-sm font-medium capitalize ${getStatusColor()}`}>
                  {status}
                </span>
              </div>
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

        <Card className="max-w-md mx-auto">
          <CardHeader className="space-y-1">
            <CardTitle className="text-lg font-semibold">Listening</CardTitle>
            <CardDescription>Waiting for commands from receiver</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {streamActive ? (
                <>
                  <Mic className="h-4 w-4 text-destructive" />
                  <span>Microphone active</span>
                </>
              ) : (
                <>
                  <MicOff className="h-4 w-4" />
                  <span>Standby mode</span>
                </>
              )}
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  )
}

export default Transmitter
