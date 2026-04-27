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
    return 'Interrogation'
  }

  if (phase === 'voting') {
    return 'Voting'
  }

  if (phase === 'result') {
    return 'Reveal'
  }

  return 'Lobby'
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
    initialSession?.roomCode ? 'Trying to restore your session...' : '',
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
      setFeedback('Connection lost. We will restore your room automatically when the socket reconnects.')
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
      setFeedback(`Rejoined room ${payload.roomCode}.`)
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
          setFeedback(response?.error || 'Action failed.')
        }
        resolve(response)
      })
    })
  }

  async function handleCreateRoom() {
    if (!playerName.trim()) {
      setFeedback('Enter your player name first.')
      return
    }

    setPrivateRole(null)
    setResult(null)
    const response = await runAckEvent('createRoom', { playerName }, 'Creating room')
    if (response?.ok) {
      setPlayerId(response.playerId)
      setSessionId(response.sessionId)
      setRoomCode(response.roomCode)
      setRoomCodeInput(response.roomCode)
    }
  }

  async function handleJoinRoom() {
    if (!playerName.trim()) {
      setFeedback('Enter your player name first.')
      return
    }

    if (!roomCodeInput.trim()) {
      setFeedback('Enter a room code.')
      return
    }

    setPrivateRole(null)
    setResult(null)
    const response = await runAckEvent(
      'joinRoom',
      { playerName, roomCode: roomCodeInput.toUpperCase() },
      'Joining room',
    )
    if (response?.ok) {
      setPlayerId(response.playerId)
      setSessionId(response.sessionId)
      setRoomCode(response.roomCode)
      setRoomCodeInput(response.roomCode)
    }
  }

  async function handleStartGame() {
    await runAckEvent('startGame', { roomCode }, 'Starting game')
  }

  async function handleNextRound() {
    setPrivateRole(null)
    setResult(null)
    await runAckEvent('nextRound', { roomCode }, 'Starting next round')
  }

  async function handleSendMessage(event) {
    event.preventDefault()

    if (!chatMessage.trim()) {
      return
    }

    const response = await runAckEvent(
      'sendMessage',
      { roomCode, message: chatMessage },
      'Sending message',
    )

    if (response?.ok) {
      setChatMessage('')
    }
  }

  async function handleReaction(reaction) {
    await runAckEvent('sendMessage', { roomCode, reaction }, 'Sending reaction')
  }

  async function handleVote(targetId) {
    await runAckEvent('votePlayer', { roomCode, targetId }, 'Casting vote')
  }

  async function handleRevealEarly() {
    await runAckEvent('revealResult', { roomCode }, 'Revealing result')
  }

  async function handleGuessLocation(location) {
    const response = await runAckEvent(
      'guessLocation',
      { roomCode, location },
      'Guessing location',
    )

    if (!response?.ok) {
      return
    }

    if (response.correct) {
      setFeedback('Correct guess. The spy stole the round.')
      return
    }

    setGuessModalOpen(false)
    setFeedback(response.message || 'Wrong guess. The round continues.')
  }

  async function handleLeaveRoom() {
    await runAckEvent('leaveRoom', {}, 'Leaving room')
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
            {socketReady ? 'LIVE' : 'OFFLINE'}
          </span>
          <span className="status-pill ghost">Spy Party Chaos</span>
          {isInRoom && <span className="status-pill highlight">Room {roomCode}</span>}
        </div>

        <div className="title-wrap">
          <p className="eyebrow">Real-time social deduction</p>
          <h1>Spy Party Chaos</h1>
          <p className="subtitle">
            One spy. One room. Everyone talks. The wrong accusation hands the round to the infiltrator.
          </p>
        </div>

        {feedback && <div className="feedback-banner">{feedback}</div>}

        {!isInRoom && (
          <div className="home-grid">
            <section className="card">
              <label className="field-label" htmlFor="player-name">
                Codename
              </label>
              <input
                id="player-name"
                className="input"
                value={playerName}
                onChange={(event) => setPlayerName(event.target.value)}
                placeholder="Agent Neon"
                maxLength={18}
              />
              <button className="primary-button" onClick={handleCreateRoom} disabled={busyAction !== ''}>
                {busyAction === 'Creating room' ? 'Creating...' : 'Create Room'}
              </button>
            </section>

            <section className="card">
              <label className="field-label" htmlFor="room-code">
                Room Code
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
                {busyAction === 'Joining room' ? 'Joining...' : 'Join Room'}
              </button>
            </section>
          </div>
        )}

        {isInRoom && roomState && (
          <div className="game-grid">
            <section className="card spotlight-card">
              <div className="section-heading">
                <div>
                  <p className="mini-label">Phase</p>
                  <h2>{phaseLabel(phase)}</h2>
                </div>
                <div className="clock-box">
                  <span>Timer</span>
                  <strong key={tick}>{phase === 'lobby' ? '--' : timeRemaining}</strong>
                </div>
              </div>

              {phase === 'lobby' && (
                <div className="role-panel neutral">
                  <p>Share room code <strong>{roomCode}</strong> and wait for the host to launch the round.</p>
                  <p className="helper-text">
                    Minimum players: 3. Everyone must be connected before a round can start.
                  </p>
                </div>
              )}

              {phase !== 'lobby' && privateRole?.roleType === 'spy' && (
                <div className="role-panel spy">
                  <p className="role-badge">YOU ARE SPY</p>
                  <h3>Blend in and steal the truth.</h3>
                  <p>You do not know the location or assigned roles.</p>
                  <p className="hint-line">Hint: {privateRole.hint}</p>
                  <div className="action-cluster">
                    <button
                      className="secondary-button compact-button"
                      onClick={() => setGuessModalOpen(true)}
                      disabled={!canGuessLocation || busyAction !== ''}
                    >
                      {privateRole?.guessUsed ? 'Guess Used' : 'Guess Location'}
                    </button>
                  </div>
                </div>
              )}

              {phase !== 'lobby' && privateRole?.roleType === 'civilian' && (
                <div className="role-panel civilian">
                  <p className="role-badge">CIVILIAN</p>
                  <h3>{privateRole.location}</h3>
                  <p>Your role is <strong>{privateRole.role}</strong>.</p>
                  <p className="hint-line">Hint: {privateRole.hint}</p>
                </div>
              )}

              {roomState.chaosEvent && phase === 'chat' && (
                <div className="chaos-card">
                  <span>Chaos Event</span>
                  <p>{roomState.chaosEvent}</p>
                </div>
              )}

              {phase === 'lobby' && (
                <button className="primary-button" onClick={handleStartGame} disabled={!canStart || busyAction !== ''}>
                  {busyAction === 'Starting game' ? 'Starting...' : isHost ? 'Start Game' : 'Waiting for Host'}
                </button>
              )}

              {phase === 'voting' && (
                <div className="vote-instructions">
                  <p>Tap the player you think is the spy. Votes reveal automatically when everyone has voted.</p>
                  <p className="helper-text">
                    {roomState.voteCount}/{players.length} votes locked in.
                    {myVote ? ' Your vote is in.' : ' You still need to vote.'}
                  </p>
                </div>
              )}

              {phase === 'result' && result && (
                <div className="result-card elevated">
                  <p className={`result-badge ${result.winningTeam}`}>
                    {result.winningTeam === 'civilians' ? 'Civilians Win' : 'Spy Wins'}
                  </p>
                  <h3>{result.summary}</h3>
                  <div className="result-grid">
                    <div>
                      <span className="mini-label">Spy</span>
                      <p><strong>{result.spyName}</strong></p>
                    </div>
                    <div>
                      <span className="mini-label">Location</span>
                      <p><strong>{result.location}</strong></p>
                    </div>
                    <div>
                      <span className="mini-label">Accused</span>
                      <p><strong>{result.accusedName}</strong></p>
                    </div>
                    <div>
                      <span className="mini-label">Victory</span>
                      <p><strong>{result.victoryType}</strong></p>
                    </div>
                  </div>
                  {result.guessedLocation && (
                    <p className="helper-text">Spy guessed: {result.guessedLocation}</p>
                  )}
                  <p className="helper-text">Hint was: {result.hint}</p>
                  <div className="action-cluster">
                    <button
                      className="primary-button compact-button"
                      onClick={handleNextRound}
                      disabled={!canReplay || busyAction !== ''}
                    >
                      {busyAction === 'Starting next round'
                        ? 'Starting...'
                        : isHost
                          ? 'Play Next Round'
                          : 'Waiting for Host'}
                    </button>
                    <button className="secondary-button compact-button" onClick={handleLeaveRoom} disabled={busyAction !== ''}>
                      Leave Room
                    </button>
                  </div>
                </div>
              )}
            </section>

            <section className="card">
              <div className="section-heading">
                <div>
                  <p className="mini-label">Agents</p>
                  <h2>Player List</h2>
                </div>
                <span className="status-pill ghost">{players.length} in room</span>
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
                        {player.isHost ? 'Host' : 'Player'}
                        {isSelf ? ' / You' : ''}
                        {!player.connected ? ' / Reconnecting' : ''}
                        {phase === 'voting' && hasVoted ? ' / Voted' : ''}
                        {phase === 'result' && revealRole ? ` / ${revealRole.role}` : ''}
                      </small>
                    </button>
                  )
                })}
              </div>

              {phase === 'voting' && isHost && (
                <button className="secondary-button" onClick={handleRevealEarly} disabled={busyAction !== ''}>
                  Reveal Early
                </button>
              )}

              {phase !== 'result' && (
                <button className="ghost-button" onClick={handleLeaveRoom} disabled={busyAction !== ''}>
                  Leave Room
                </button>
              )}
            </section>

            <section className="card chat-card">
              <div className="section-heading">
                <div>
                  <p className="mini-label">Room Feed</p>
                  <h2>Chat</h2>
                </div>
                {me && (
                  <span className="status-pill ghost">
                    {me.connected ? 'Connected' : 'Reconnecting'}
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
                  placeholder={phase === 'chat' ? 'Drop suspicion into the room...' : 'Chat opens during interrogation'}
                  disabled={phase !== 'chat' || busyAction !== ''}
                  maxLength={180}
                />
                <button className="primary-button" type="submit" disabled={phase !== 'chat' || busyAction !== ''}>
                  Send
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
                <p className="mini-label">Spy Guess</p>
                <h2>Pick The Hidden Location</h2>
              </div>
              <button className="close-button" onClick={() => setGuessModalOpen(false)}>
                Close
              </button>
            </div>
            <p className="helper-text">
              One shot only. A correct guess wins the round immediately. A wrong guess locks this button for the rest of the round.
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
