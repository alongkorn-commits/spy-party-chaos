import { useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import './App.css'

const emojiReactions = ['\u{1F525}', '\u{1F440}', '\u{1F608}', '\u{1F928}', '\u{1F3AD}']
const socketServerUrl =
  import.meta.env.VITE_API_URL || "http://localhost:3001"
const sessionStorageKey = 'spy-party-session'
const nameStorageKey = 'spy-party-name'

function readSavedSession() {
  try {
    return JSON.parse(localStorage.getItem(sessionStorageKey) || 'null')
  } catch {
    return null
  }
}

function writeSavedSession(session) {
  if (!session) {
    localStorage.removeItem(sessionStorageKey)
    return
  }

  localStorage.setItem(sessionStorageKey, JSON.stringify(session))
}

function createSocket(sessionId) {
  return io(socketServerUrl, {
    autoConnect: false,
    transports: ["websocket", "polling"],
    withCredentials: true,
    auth: {
      sessionId,
    },
  })
}

function formatTimeRemaining(timerEndsAt) {
  if (!timerEndsAt) {
    return '--'
  }

  const seconds = Math.max(0, Math.ceil((timerEndsAt - Date.now()) / 1000))
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return `${minutes}:${String(remainder).padStart(2, '0')}`
}

function phaseLabel(phase) {
  if (phase === 'chat') {
    return 'สอบสวน'
  }

  if (phase === 'voting') {
    return 'ลงคะแนน'
  }

  if (phase === 'result') {
    return 'เฉลย'
  }

  return 'ล็อบบี้'
}

function App() {
  const [initialSession] = useState(() => readSavedSession())
  const socketRef = useRef(null)
  const [socketReady, setSocketReady] = useState(false)
  const [playerName, setPlayerName] = useState(localStorage.getItem(nameStorageKey) || '')
  const [roomCodeInput, setRoomCodeInput] = useState(initialSession?.roomCode || '')
  const [roomCode, setRoomCode] = useState(initialSession?.roomCode || '')
  const [playerId, setPlayerId] = useState(initialSession?.playerId || '')
  const [sessionId, setSessionId] = useState(initialSession?.sessionId || '')
  const [roomState, setRoomState] = useState(null)
  const [privateRole, setPrivateRole] = useState(null)
  const [result, setResult] = useState(null)
  const [chatMessage, setChatMessage] = useState('')
  const [feedback, setFeedback] = useState(
    initialSession?.roomCode ? 'กำลังพยายามกู้คืนเซสชันของคุณ...' : '',
  )
  const [busyAction, setBusyAction] = useState('')
  const [tick, setTick] = useState(0)
  const [guessModalOpen, setGuessModalOpen] = useState(false)

  useEffect(() => {
    const socket = createSocket(initialSession?.sessionId || '')
    socketRef.current = socket
    socket.connect()

    const onConnect = () => {
      setSocketReady(true)
      if (!readSavedSession()?.roomCode) {
        setFeedback('')
      }
    }

    const onDisconnect = () => {
      setSocketReady(false)
      setFeedback('การเชื่อมต่อขาดหาย ระบบจะกู้คืนห้องของคุณอัตโนมัติเมื่อเชื่อมต่อใหม่')
    }

    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('sessionRestored', (payload) => {
      setRoomCode(payload.roomCode)
      setRoomCodeInput(payload.roomCode)
      setPlayerId(payload.playerId)
      setSessionId(payload.sessionId)
      setPlayerName(payload.playerName)
      writeSavedSession({
        roomCode: payload.roomCode,
        playerId: payload.playerId,
        sessionId: payload.sessionId,
      })
      setFeedback(`กลับเข้าห้อง ${payload.roomCode} อีกครั้งแล้ว`)
    })
    socket.on('roomState', (nextRoomState) => {
      setRoomState(nextRoomState)
      setRoomCode(nextRoomState.code)
      setRoomCodeInput(nextRoomState.code)
      if (nextRoomState.phase === 'lobby') {
        setPrivateRole(null)
        setResult(null)
      } else if (nextRoomState.phase !== 'result') {
        setResult(null)
      }
    })
    socket.on('assignRole', (payload) => {
      setPrivateRole(payload)
    })
    socket.on('revealResult', (payload) => {
      setResult(payload)
      setGuessModalOpen(false)
    })

    return () => {
      socket.disconnect()
    }
  }, [initialSession?.sessionId])

  useEffect(() => {
    const interval = window.setInterval(() => setTick((value) => value + 1), 1000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    localStorage.setItem(nameStorageKey, playerName)
  }, [playerName])

  useEffect(() => {
    if (!sessionId && !playerId && !roomCode) {
      writeSavedSession(null)
      return
    }

    writeSavedSession({ sessionId, playerId, roomCode })
  }, [playerId, roomCode, sessionId])

  const players = roomState?.players || []
  const phase = roomState?.phase || 'home'
  const isHost = roomState?.hostId === playerId
  const isInRoom = Boolean(roomCode)
  const myVote = roomState?.votedPlayerIds?.includes(playerId)
  const me = players.find((player) => player.id === playerId) || null
  const votedPlayerIds = roomState?.votedPlayerIds || []
  const timeRemaining = formatTimeRemaining(roomState?.timerEndsAt)
  const canStart = isHost && players.length >= 3 && phase === 'lobby'
  const canReplay = isHost && phase === 'result'
  const canGuessLocation =
    phase === 'chat' &&
    privateRole?.roleType === 'spy' &&
    privateRole?.guessUsed !== true

  function runAckEvent(eventName, payload, actionLabel) {
    return new Promise((resolve) => {
      setBusyAction(actionLabel)
      setFeedback('')
      socketRef.current.emit(eventName, payload, (response) => {
        setBusyAction('')
        if (!response?.ok) {
          setFeedback(response?.error || 'การดำเนินการล้มเหลว')
        }
        resolve(response)
      })
    })
  }

  async function handleCreateRoom() {
    if (!playerName.trim()) {
      setFeedback('กรอกชื่อผู้เล่นของคุณก่อน')
      return
    }

    setPrivateRole(null)
    setResult(null)
    const response = await runAckEvent('createRoom', { playerName }, 'กำลังสร้างห้อง')
    if (response?.ok) {
      setPlayerId(response.playerId)
      setSessionId(response.sessionId)
      setRoomCode(response.roomCode)
      setRoomCodeInput(response.roomCode)
    }
  }

  async function handleJoinRoom() {
    if (!playerName.trim()) {
      setFeedback('กรอกชื่อผู้เล่นของคุณก่อน')
      return
    }

    if (!roomCodeInput.trim()) {
      setFeedback('กรอกรหัสห้อง')
      return
    }

    setPrivateRole(null)
    setResult(null)
    const response = await runAckEvent(
      'joinRoom',
      { playerName, roomCode: roomCodeInput.toUpperCase() },
      'กำลังเข้าห้อง',
    )
    if (response?.ok) {
      setPlayerId(response.playerId)
      setSessionId(response.sessionId)
      setRoomCode(response.roomCode)
      setRoomCodeInput(response.roomCode)
    }
  }

  async function handleStartGame() {
    await runAckEvent('startGame', { roomCode }, 'กำลังเริ่มเกม')
  }

  async function handleNextRound() {
    setPrivateRole(null)
    setResult(null)
    await runAckEvent('nextRound', { roomCode }, 'กำลังเริ่มรอบถัดไป')
  }

  async function handleSendMessage(event) {
    event.preventDefault()

    if (!chatMessage.trim()) {
      return
    }

    const response = await runAckEvent(
      'sendMessage',
      { roomCode, message: chatMessage },
      'กำลังส่งข้อความ',
    )

    if (response?.ok) {
      setChatMessage('')
    }
  }

  async function handleReaction(reaction) {
    await runAckEvent('sendMessage', { roomCode, reaction }, 'กำลังส่งรีแอ็กชัน')
  }

  async function handleVote(targetId) {
    await runAckEvent('votePlayer', { roomCode, targetId }, 'กำลังลงคะแนน')
  }

  async function handleRevealEarly() {
    await runAckEvent('revealResult', { roomCode }, 'กำลังเฉลยผล')
  }

  async function handleGuessLocation(location) {
    const response = await runAckEvent(
      'guessLocation',
      { roomCode, location },
      'กำลังทายสถานที่',
    )

    if (!response?.ok) {
      return
    }

    if (response.correct) {
      setFeedback('ทายถูก สปายขโมยรอบนี้ไปได้')
      return
    }

    setGuessModalOpen(false)
    setFeedback(response.message || 'ทายผิด รอบยังดำเนินต่อไป')
  }

  async function handleLeaveRoom() {
    await runAckEvent('leaveRoom', {}, 'กำลังออกจากห้อง')
    setRoomCode('')
    setRoomCodeInput('')
    setPlayerId('')
    setSessionId('')
    setRoomState(null)
    setPrivateRole(null)
    setResult(null)
    setGuessModalOpen(false)
    setFeedback('')
    writeSavedSession(null)
  }

  return (
    <main className="app-shell">
      <div className="ambient ambient-a"></div>
      <div className="ambient ambient-b"></div>

      <section className="panel hero-panel">
        <div className="status-row">
          <span className={`status-pill ${socketReady ? 'online' : 'offline'}`}>
            {socketReady ? 'ออนไลน์' : 'ออฟไลน์'}
          </span>
          <span className="status-pill ghost">Spy Party Chaos</span>
          {isInRoom && <span className="status-pill highlight">ห้อง {roomCode}</span>}
        </div>

        <div className="title-wrap">
          <p className="eyebrow">เกมจับพิรุธแบบเรียลไทม์</p>
          <h1>Spy Party Chaos</h1>
          <p className="subtitle">
            หนึ่งสปาย หนึ่งห้อง ทุกคนพูดคุย หากกล่าวหาผิด รอบนี้จะตกเป็นของผู้แทรกซึม
          </p>
        </div>

        {feedback && <div className="feedback-banner">{feedback}</div>}

        {!isInRoom && (
          <div className="home-grid">
            <section className="card">
              <label className="field-label" htmlFor="player-name">
                โค้ดเนม
              </label>
              <input
                id="player-name"
                className="input"
                value={playerName}
                onChange={(event) => setPlayerName(event.target.value)}
                placeholder="เอเจนต์นีออน"
                maxLength={18}
              />
              <button className="primary-button" onClick={handleCreateRoom} disabled={busyAction !== ''}>
                {busyAction === 'กำลังสร้างห้อง' ? 'กำลังสร้าง...' : 'สร้างห้อง'}
              </button>
            </section>

            <section className="card">
              <label className="field-label" htmlFor="room-code">
                รหัสห้อง
              </label>
              <input
                id="room-code"
                className="input code-input"
                value={roomCodeInput}
                onChange={(event) => setRoomCodeInput(event.target.value.toUpperCase())}
                placeholder="A7K9Q"
                maxLength={5}
              />
              <button className="secondary-button" onClick={handleJoinRoom} disabled={busyAction !== ''}>
                {busyAction === 'กำลังเข้าห้อง' ? 'กำลังเข้า...' : 'เข้าห้อง'}
              </button>
            </section>
          </div>
        )}

        {isInRoom && roomState && (
          <div className="game-grid">
            <section className="card spotlight-card">
              <div className="section-heading">
                <div>
                  <p className="mini-label">ช่วง</p>
                  <h2>{phaseLabel(phase)}</h2>
                </div>
                <div className="clock-box">
                  <span>เวลา</span>
                  <strong key={tick}>{phase === 'lobby' ? '--' : timeRemaining}</strong>
                </div>
              </div>

              {phase === 'lobby' && (
                <div className="role-panel neutral">
                  <p>แชร์รหัสห้อง <strong>{roomCode}</strong> แล้วรอหัวหน้าห้องเริ่มรอบ</p>
                  <p className="helper-text">
                    ผู้เล่นขั้นต่ำ: 3 คน ทุกคนต้องเชื่อมต่ออยู่ก่อนเริ่มรอบ
                  </p>
                </div>
              )}

              {phase !== 'lobby' && privateRole?.roleType === 'spy' && (
                <div className="role-panel spy">
                  <p className="role-badge">คุณคือสปาย</p>
                  <h3>กลมกลืนและขโมยความจริงไป</h3>
                  <p>คุณไม่รู้สถานที่หรือบทบาทที่ถูกแจก</p>
                  <p className="hint-line">คำใบ้: {privateRole.hint}</p>
                  <div className="action-cluster">
                    <button
                      className="secondary-button compact-button"
                      onClick={() => setGuessModalOpen(true)}
                      disabled={!canGuessLocation || busyAction !== ''}
                    >
                      {privateRole?.guessUsed ? 'ใช้สิทธิ์ทายแล้ว' : 'ทายสถานที่'}
                    </button>
                  </div>
                </div>
              )}

              {phase !== 'lobby' && privateRole?.roleType === 'civilian' && (
                <div className="role-panel civilian">
                  <p className="role-badge">พลเรือน</p>
                  <h3>{privateRole.location}</h3>
                  <p>บทบาทของคุณคือ <strong>{privateRole.role}</strong></p>
                  <p className="hint-line">คำใบ้: {privateRole.hint}</p>
                </div>
              )}

              {roomState.chaosEvent && phase === 'chat' && (
                <div className="chaos-card">
                  <span>เหตุการณ์ปั่นป่วน</span>
                  <p>{roomState.chaosEvent}</p>
                </div>
              )}

              {phase === 'lobby' && (
                <button className="primary-button" onClick={handleStartGame} disabled={!canStart || busyAction !== ''}>
                  {busyAction === 'กำลังเริ่มเกม' ? 'กำลังเริ่ม...' : isHost ? 'เริ่มเกม' : 'กำลังรอหัวหน้าห้อง'}
                </button>
              )}

              {phase === 'voting' && (
                <div className="vote-instructions">
                  <p>แตะผู้เล่นที่คุณคิดว่าเป็นสปาย ระบบจะเฉลยอัตโนมัติเมื่อทุกคนลงคะแนนแล้ว</p>
                  <p className="helper-text">
                    ลงคะแนนแล้ว {roomState.voteCount}/{players.length} เสียง
                    {myVote ? ' คุณลงคะแนนแล้ว' : ' คุณยังต้องลงคะแนน'}
                  </p>
                </div>
              )}

              {phase === 'result' && result && (
                <div className="result-card elevated">
                  <p className={`result-badge ${result.winningTeam}`}>
                    {result.winningTeam === 'civilians' ? 'พลเรือนชนะ' : 'สปายชนะ'}
                  </p>
                  <h3>{result.summary}</h3>
                  <div className="result-grid">
                    <div>
                      <span className="mini-label">สปาย</span>
                      <p><strong>{result.spyName}</strong></p>
                    </div>
                    <div>
                      <span className="mini-label">สถานที่</span>
                      <p><strong>{result.location}</strong></p>
                    </div>
                    <div>
                      <span className="mini-label">ผู้ถูกกล่าวหา</span>
                      <p><strong>{result.accusedName}</strong></p>
                    </div>
                    <div>
                      <span className="mini-label">ชัยชนะ</span>
                      <p><strong>{result.victoryType}</strong></p>
                    </div>
                  </div>
                  {result.guessedLocation && (
                    <p className="helper-text">สปายทายว่า: {result.guessedLocation}</p>
                  )}
                  <p className="helper-text">คำใบ้คือ: {result.hint}</p>
                  <div className="action-cluster">
                    <button
                      className="primary-button compact-button"
                      onClick={handleNextRound}
                      disabled={!canReplay || busyAction !== ''}
                    >
                      {busyAction === 'กำลังเริ่มรอบถัดไป'
                        ? 'กำลังเริ่ม...'
                        : isHost
                          ? 'เล่นรอบถัดไป'
                          : 'กำลังรอหัวหน้าห้อง'}
                    </button>
                    <button className="secondary-button compact-button" onClick={handleLeaveRoom} disabled={busyAction !== ''}>
                      ออกจากห้อง
                    </button>
                  </div>
                </div>
              )}
            </section>

            <section className="card">
              <div className="section-heading">
                <div>
                  <p className="mini-label">เอเจนต์</p>
                  <h2>รายชื่อผู้เล่น</h2>
                </div>
                <span className="status-pill ghost">{players.length} คนในห้อง</span>
              </div>

              <div className="player-list">
                {players.map((player) => {
                  const isSelf = player.id === playerId
                  const hasVoted = votedPlayerIds.includes(player.id)
                  const revealRole = result?.roles?.find((entry) => entry.id === player.id)

                  return (
                    <button
                      key={player.id}
                      className={[
                        'player-chip',
                        isSelf ? 'self' : '',
                        hasVoted ? 'voted' : '',
                        !player.connected ? 'disconnected' : '',
                        phase === 'voting' ? 'clickable' : '',
                      ].join(' ')}
                      disabled={phase !== 'voting' || player.id === playerId || busyAction !== ''}
                      onClick={() => handleVote(player.id)}
                    >
                      <span>{player.name}</span>
                      <small>
                        {player.isHost ? 'หัวหน้าห้อง' : 'ผู้เล่น'}
                        {isSelf ? ' / คุณ' : ''}
                        {!player.connected ? ' / กำลังเชื่อมต่อใหม่' : ''}
                        {phase === 'voting' && hasVoted ? ' / ลงคะแนนแล้ว' : ''}
                        {phase === 'result' && revealRole ? ` / ${revealRole.role}` : ''}
                      </small>
                    </button>
                  )
                })}
              </div>

              {phase === 'voting' && isHost && (
                <button className="secondary-button" onClick={handleRevealEarly} disabled={busyAction !== ''}>
                  เฉลยทันที
                </button>
              )}

              {phase !== 'result' && (
                <button className="ghost-button" onClick={handleLeaveRoom} disabled={busyAction !== ''}>
                  ออกจากห้อง
                </button>
              )}
            </section>

            <section className="card chat-card">
              <div className="section-heading">
                <div>
                  <p className="mini-label">ฟีดห้อง</p>
                  <h2>แชต</h2>
                </div>
                {me && (
                  <span className="status-pill ghost">
                    {me.connected ? 'เชื่อมต่ออยู่' : 'กำลังเชื่อมต่อใหม่'}
                  </span>
                )}
              </div>

              <div className="message-list">
                {(roomState.messages || []).map((message) => (
                  <article key={message.id} className={`message ${message.type}`}>
                    <div className="message-head">
                      <strong>{message.sender}</strong>
                      <span>
                        {new Date(message.createdAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                    <p>{message.text}</p>
                  </article>
                ))}
              </div>

              <div className="reaction-row">
                {emojiReactions.map((reaction) => (
                  <button
                    key={reaction}
                    className="reaction-button"
                    onClick={() => handleReaction(reaction)}
                    disabled={phase !== 'chat' || busyAction !== ''}
                  >
                    {reaction}
                  </button>
                ))}
              </div>

              <form className="chat-form" onSubmit={handleSendMessage}>
                <input
                  className="input"
                  value={chatMessage}
                  onChange={(event) => setChatMessage(event.target.value)}
                  placeholder={phase === 'chat' ? 'ส่งความสงสัยเข้าไปในห้อง...' : 'แชตจะเปิดในช่วงสอบสวน'}
                  disabled={phase !== 'chat' || busyAction !== ''}
                  maxLength={180}
                />
                <button className="primary-button" type="submit" disabled={phase !== 'chat' || busyAction !== ''}>
                  ส่ง
                </button>
              </form>
            </section>
          </div>
        )}
      </section>

      {guessModalOpen && canGuessLocation && (
        <div className="modal-backdrop" onClick={() => setGuessModalOpen(false)}>
          <div className="guess-modal" onClick={(event) => event.stopPropagation()}>
            <div className="section-heading modal-heading">
              <div>
                <p className="mini-label">การทายของสปาย</p>
                <h2>เลือกสถานที่ที่ซ่อนอยู่</h2>
              </div>
              <button className="close-button" onClick={() => setGuessModalOpen(false)}>
                ปิด
              </button>
            </div>
            <p className="helper-text">
              มีสิทธิ์เพียงครั้งเดียว ทายถูกจะชนะรอบทันที ทายผิดปุ่มนี้จะถูกล็อกตลอดรอบที่เหลือ
            </p>
            <div className="location-grid">
              {(privateRole?.locationOptions || roomState?.availableLocations || []).map((location) => (
                <button
                  key={location}
                  className="location-option"
                  onClick={() => handleGuessLocation(location)}
                  disabled={busyAction !== ''}
                >
                  {location}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </main>
  )
}

export default App
