const express = require('express');
const { spawn } = require('child_process');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');

const dataFile = path.join(__dirname, 'data', 'streams.json');

const app = express();
const port = process.env.PORT || 3000;
const hostIp = process.env.HOST_IP || '127.0.0.1';

app.use(express.static('public'));
app.use(express.json());

const MAX_STREAMS = 20;
const activeStreams = {};

// --- icecast connection (must match the icecast container's credentials) ---
const ICECAST_HOST = 'icecast-server';
const ICECAST_PORT = 8000;
const ICECAST_SOURCE_USER = 'source';
// VVV EDIT THE ICECAST PASSWORD HERE VVV
const ICECAST_SOURCE_PASS = 'password';

function updateLastPlayed(mount) {
    if (activeStreams[mount]) {
        activeStreams[mount].lastPlayedAt = Date.now();
    }
}

function getLRUStream() {
    let lruMount = null;
    let lruTime = Infinity;
    
    for (const [mount, stream] of Object.entries(activeStreams)) {
        // only consider actively playing streams
        if (!stream.paused && stream.lastPlayedAt < lruTime) {
            lruTime = stream.lastPlayedAt;
            lruMount = mount;
        }
    }
    
    return lruMount;
}

function pauseLRUStream() {
    const lruMount = getLRUStream();
    if (lruMount) {
        const stream = activeStreams[lruMount];
        if (stream.process) {
            stream.process.kill();
            stream.process = null;
        }
        stream.paused = true;
        savestate();
        console.log(`Paused LRU stream: ${lruMount}`);
        return true;
    }
    return false;
}

const nowPlaying = {};

function setNowPlaying(mount, title) {
    if (!title) return;
    const state = nowPlaying[mount] = nowPlaying[mount] || {};
    if (state.title === title) return;   // icecast already has this one
    state.title = title;
    state.attempts = 0;
    pushNowPlaying(mount);
}

function pushNowPlaying(mount) {
    const state = nowPlaying[mount];
    if (!state || state.inflight) return;
    state.inflight = true;

    const auth = Buffer.from(`${ICECAST_SOURCE_USER}:${ICECAST_SOURCE_PASS}`).toString('base64');
    const sent = state.title;
    const params = new URLSearchParams({
        mount: `/${mount}`,
        mode: 'updinfo',
        charset: 'UTF-8',
        song: sent
    });

    const retry = (reason) => {
        state.inflight = false;
        if (state.attempts++ < 5) {
            // 4xx early on usually just means the source hasn't connected yet
            state.timer = setTimeout(() => pushNowPlaying(mount), 2000 * state.attempts);
        } else {
            console.warn(`[${mount}] metadata update gave up: ${reason}`);
        }
    };

    fetch(`http://${ICECAST_HOST}:${ICECAST_PORT}/admin/metadata?${params}`, {
        headers: { Authorization: `Basic ${auth}` }
    })
        .then(res => {
            if (!res.ok) return retry(`HTTP ${res.status}`);
            state.inflight = false;
            console.log(`[${mount}] now-playing set to "${sent}"`);
            if (state.title !== sent) pushNowPlaying(mount);   // newer title arrived mid-flight
        })
        .catch(err => retry(err.message));
}

// forget push state for a mount (its icecast mountpoint is gone, so the dedupe
// in setNowPlaying must not skip re-sending the same title to a fresh mount)
function clearNowPlaying(mount) {
    const state = nowPlaying[mount];
    if (state && state.timer) clearTimeout(state.timer);
    delete nowPlaying[mount];
}

function startMetadataReader(mount, sourceUri) {
    const reader = { stopped: false, socket: null, timer: null };

    reader.stop = () => {
        reader.stopped = true;
        if (reader.timer) clearTimeout(reader.timer);
        if (reader.socket) reader.socket.destroy();
    };

    // permanent conditions: don't retry, the ticker just keeps the description
    const giveUp = (reason) => {
        console.log(`[${mount}] song metadata unavailable: ${reason}`);
    };

    // transient conditions: the stream itself is still up (ffmpeg has its own
    // connection), so quietly try again in a bit
    const reconnect = (reason) => {
        if (reader.stopped || reader.timer) return;
        console.log(`[${mount}] song metadata: ${reason}; retrying in 30s`);
        reader.timer = setTimeout(() => {
            reader.timer = null;
            connect(sourceUri, 0);
        }, 30000);
    };

    function connect(uri, redirects) {
        if (reader.stopped) return;

        let u;
        try { u = new URL(uri); } catch { return giveUp('unparseable source uri'); }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
            return giveUp(`${u.protocol}// source`);
        }

        const secure = u.protocol === 'https:';
        const port = u.port || (secure ? 443 : 80);
        const sock = secure
            ? tls.connect({ host: u.hostname, port, servername: u.hostname })
            : net.connect(port, u.hostname);
        reader.socket = sock;

        // a healthy radio stream never goes quiet this long; treat as a stall
        sock.setTimeout(30000, () => sock.destroy(new Error('stalled')));

        sock.on(secure ? 'secureConnect' : 'connect', () => {
            sock.write(
                `GET ${u.pathname}${u.search} HTTP/1.0\r\n` +
                `Host: ${u.host}\r\n` +
                `Icy-MetaData: 1\r\n` +
                `User-Agent: wiiradio-stream-bridge\r\n` +
                `Connection: close\r\n\r\n`
            );
        });

        let buf = Buffer.alloc(0);
        let phase = 'headers';   // headers -> audio -> metalen -> meta -> audio ...
        let metaint = 0;
        let audioLeft = 0;
        let metaLeft = 0;
        let lastTitle = null;

        sock.on('data', (chunk) => {
            if (phase === 'done') return;
            buf = Buffer.concat([buf, chunk]);

            if (phase === 'headers') {
                const end = buf.indexOf('\r\n\r\n');
                if (end === -1) {
                    if (buf.length > 65536) {
                        phase = 'done';
                        sock.destroy();
                        giveUp('oversized response headers');
                    }
                    return;
                }
                const head = buf.toString('latin1', 0, end);
                buf = buf.slice(end + 4);

                const status = head.match(/^(?:HTTP\/\d\.\d|ICY)\s+(\d+)/i);
                const code = status ? parseInt(status[1], 10) : 0;
                const location = (head.match(/^location:\s*(.+)$/im) || [])[1];

                if (code >= 300 && code < 400 && location) {
                    phase = 'done';
                    sock.destroy();
                    if (redirects >= 5) return giveUp('too many redirects');
                    let next;
                    try { next = new URL(location.trim(), uri).href; } catch { return giveUp('bad redirect'); }
                    return connect(next, redirects + 1);
                }
                if (code !== 200) {
                    phase = 'done';
                    sock.destroy();
                    return giveUp(`HTTP ${code || 'unparseable status line'}`);
                }

                metaint = parseInt((head.match(/^icy-metaint:\s*(\d+)/im) || [])[1], 10);
                if (!metaint || metaint > 1048576) {
                    phase = 'done';
                    sock.destroy();
                    return giveUp('source sends no in-band song metadata');
                }
                phase = 'audio';
                audioLeft = metaint;
                // fall through: body bytes often arrive with the headers
            }

            // consume the interleaved audio/metadata framing; audio is discarded
            while (buf.length) {
                if (phase === 'audio') {
                    const n = Math.min(audioLeft, buf.length);
                    buf = buf.slice(n);
                    audioLeft -= n;
                    if (audioLeft === 0) phase = 'metalen';
                } else if (phase === 'metalen') {
                    metaLeft = buf[0] * 16;
                    buf = buf.slice(1);
                    if (metaLeft === 0) {
                        phase = 'audio';
                        audioLeft = metaint;
                    } else {
                        phase = 'meta';
                    }
                } else if (phase === 'meta') {
                    if (buf.length < metaLeft) return;   // wait for the full block
                    const meta = buf.toString('utf8', 0, metaLeft).replace(/\0+$/, '');
                    buf = buf.slice(metaLeft);
                    phase = 'audio';
                    audioLeft = metaint;

                    const title = (meta.match(/StreamTitle='(.*?)';/) || [])[1];
                    if (title && title !== lastTitle) {
                        lastTitle = title;
                        setNowPlaying(mount, title);
                    }
                } else {
                    return;   // 'done'
                }
            }
        });

        sock.on('error', (err) => reconnect(err.message));
        sock.on('close', () => {
            if (phase !== 'done') reconnect('source closed the connection');
        });
    }

    connect(sourceUri, 0);
    return reader;
}

function connectIcecastSource(ffmpegProcess, mount, streamName, streamDesc) {
    const auth = Buffer.from(`${ICECAST_SOURCE_USER}:${ICECAST_SOURCE_PASS}`).toString('base64');
    const sock = net.connect(ICECAST_PORT, ICECAST_HOST);
    let handshakeDone = false;
    let respBuf = '';

    ffmpegProcess._icecastSocket = sock;

    sock.on('connect', () => {
        const headers = [
            `PUT /${mount} HTTP/1.1`,
            `Host: ${ICECAST_HOST}:${ICECAST_PORT}`,
            `Authorization: Basic ${auth}`,
            `Content-Type: audio/mpeg`,
            `Ice-Public: 0`,
            `Ice-Name: ${plsSafe(streamName)}`,
            `Ice-Description: ${plsSafe(streamDesc)}`,
            // fills WiiRadio's $GENRE menu line (it reads no ID3 text tags)
            `Ice-Genre: ${plsSafe(streamDesc)}`,
            // make Icecast advertise icy-br
            `Ice-Audio-Info: bitrate=128;samplerate=44100;channels=2`,
            `Ice-Bitrate: 128`,
            `Expect: 100-continue`,
            '', ''
        ].join('\r\n');
        sock.write(headers);
    });

    sock.on('data', (chunk) => {
        if (handshakeDone) return;   // once streaming, ignore anything else
        respBuf += chunk.toString('latin1');
        const lineEnd = respBuf.indexOf('\r\n');
        if (lineEnd === -1) return;  // wait for the full status line
        const statusLine = respBuf.slice(0, lineEnd);
        const code = parseInt((statusLine.match(/HTTP\/\d\.\d\s+(\d+)/) || [])[1], 10);

        if (code === 100 || code === 200) {
            handshakeDone = true;
            ffmpegProcess.stdout.pipe(sock);   // stream transcoded audio to icecast
            console.log(`[${mount}] icecast source connected (128k)`);
            setNowPlaying(mount, streamDesc);
        } else {
            handshakeDone = true;
            console.error(`[${mount}] icecast rejected source: ${statusLine}`);
            sock.destroy();
            ffmpegProcess.kill();
        }
    });

    sock.on('error', (err) => {
        console.error(`[${mount}] icecast socket error: ${err.message}`);
        ffmpegProcess.kill();
    });
}

function spawnFfmpeg(sourceUri, mount, streamName, streamDesc) {
    const args = [
        '-i', sourceUri,
        '-c:a', 'libmp3lame',
        '-b:a', '128k',
        '-ar', '44100',
        '-ac', '2',
        '-map_metadata', '0',   // try to carry over track title tags
        '-id3v2_version', '3',
        '-f', 'mp3',
        '-'                     // write to stdout; Node handles the icecast side
    ];

    const ffmpegProcess = spawn('ffmpeg', args);

    // fresh mountpoint, so forget any previously-pushed title: the description
    // push below must not be deduped away, nor a stale song title kept
    clearNowPlaying(mount);
    connectIcecastSource(ffmpegProcess, mount, streamName, streamDesc);
    ffmpegProcess._metaReader = startMetadataReader(mount, sourceUri);

    ffmpegProcess.stderr.on('data', (data) => {
        console.log(`[${mount}] ffmpeg: ${data.toString().trim()}`);
    });

    ffmpegProcess.on('close', (code) => {
        console.log(`[${mount}] ffmpeg exited with code ${code}`);

        // tear down the icecast connection so the mountpoint drops promptly,
        // and the song-metadata reader with it
        if (ffmpegProcess._icecastSocket) {
            ffmpegProcess._icecastSocket.destroy();
        }
        if (ffmpegProcess._metaReader) {
            ffmpegProcess._metaReader.stop();
        }

        // if ffmpeg died on its own (not via an intentional pause/stop),
        // mark the stream as paused instead of leaving a dead process
        // reference around, so the UI still shows a resumable stream.
        const stream = activeStreams[mount];
        if (stream && stream.process === ffmpegProcess) {
            stream.process = null;
            stream.paused = true;
        }
    });

    return ffmpegProcess;
}

// the mount id ends up in a url path and in an icecast mountpoint, so anything
// outside [a-z0-9._-] gets dropped rather than passed through. "AC/DC Radio"
// used to become "ac/dc-radio", which broke both the route and the mountpoint.
function mountIdFromName(name) {
    return name.trim()
        .replace(/\s+/g, '-')
        .replace(/[^a-zA-Z0-9._-]/g, '')
        .replace(/-{2,}/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '')
        .toLowerCase();
}

// .pls is a flat ini-ish format with no escaping, so a newline in a value would
// inject bogus keys into the playlist
function plsSafe(value) {
    return String(value).replace(/[\r\n]+/g, ' ').trim();
}

// wiiradio lists the .pls files it finds on the sd card by filename, so this is
// what shows up on its main interface. strip the characters FAT32 rejects.
function plsFileName(name) {
    const cleaned = plsSafe(name)
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned || 'stream';
}

function savestate() {
    const statetosave = {};
    for (const [mount, stream] of Object.entries(activeStreams)) {
        statetosave[mount] = {
            uri: stream.uri,
            name: stream.name,
            description: stream.description,
            paused: stream.paused,
            lastPlayedAt: stream.lastPlayedAt
        };
    }

    // create the data folder if it doesn't exist yet
    if (!fs.existsSync(path.dirname(dataFile))) {
        fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    }

    // use the asynchronous promise-based write
    fs.promises.writeFile(dataFile, JSON.stringify(statetosave, null, 2))
        .catch(err => console.error('failed to save state:', err));
}

function loadstate() {
    if (fs.existsSync(dataFile)) {
        try {
            const data = JSON.parse(fs.readFileSync(dataFile));
            for (const [mount, s] of Object.entries(data)) {
                let process = null;

                // if it was running before the crash/restart, start it back up
                if (!s.paused) {
                    process = spawnFfmpeg(s.uri, mount, s.name, s.description);
                }

                activeStreams[mount] = {
                    process,
                    uri: s.uri,
                    name: s.name,
                    description: s.description,
                    paused: s.paused,
                    lastPlayedAt: s.lastPlayedAt || Date.now()
                };
            }
            console.log(`restored ${Object.keys(data).length} streams from memory`);
        } catch (err) {
            console.error('failed to load state', err);
        }
    }
}

// --- routes ---

app.get('/api/status', (req, res) => {
    const streams = Object.entries(activeStreams).map(([mount, s]) => ({
        mount,
        name: s.name,
        description: s.description,
        paused: s.paused
    }));
    res.json(streams);
});

app.get('/api/playlist/:mount', (req, res) => {
    const mount = req.params.mount;
    const stream = activeStreams[mount];

    if (!stream) {
        return res.status(404).send(`no stream at "${mount}"`);
    }

    const title = plsSafe(stream.name) || mount;

    const plsContent = `[playlist]
NumberOfEntries=1
File1=http://${hostIp}:4000/${mount}
Title1=${title}
Length1=-1
Version=2`;

    // name the download after the stream, not the mountpoint. quote-safe ascii
    // fallback first, then the real utf-8 name for browsers that understand it.
    const fileName = `${plsFileName(stream.name)}.pls`;
    const asciiName = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');

    res.set('Content-Type', 'audio/x-scpls');
    res.set(
        'Content-Disposition',
        `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
    );
    res.send(plsContent);
});

app.post('/api/start', (req, res) => {
    const { uri, name, description } = req.body;

    if (!name || !uri) {
        return res.status(400).send('name and uri are required');
    }

    const mount = mountIdFromName(name);

    if (!mount) {
        return res.status(400).send('name must contain at least one letter or number');
    }

    if (activeStreams[mount]) {
        return res.status(409).send(`a stream already exists at "${mount}"`);
    }

    const activeCount = Object.values(activeStreams).filter(s => !s.paused).length;
    
    if (activeCount >= MAX_STREAMS) {
        if (!pauseLRUStream()) {
            return res.status(503).send('failed to free up a stream. please pause one manually.');
        }
    }

    const streamDesc = description && description.trim() ? description.trim() : 'converted radio stream';
    const process = spawnFfmpeg(uri, mount, name, streamDesc);

    activeStreams[mount] = {
        process,
        uri,
        name,
        description: streamDesc,
        paused: false,
        lastPlayedAt: Date.now()
    };
    savestate();
    res.send(`started playing at http://${hostIp}:4000/${mount}`);
});

app.post('/api/pause', (req, res) => {
    const { mount } = req.body;
    const stream = activeStreams[mount];

    if (!stream) {
        return res.status(404).send('no such stream');
    }
    if (stream.paused) {
        return res.send(`${mount} is already paused`);
    }

    // killing ffmpeg drops its connection to icecast, which stops the
    // broadcast for this mountpoint immediately
    stream.process.kill();
    stream.process = null;
    stream.paused = true;
    savestate();
    res.send(`paused ${mount}`);
});

app.post('/api/resume', (req, res) => {
    const { mount } = req.body;
    const stream = activeStreams[mount];

    if (!stream) {
        return res.status(404).send('no such stream');
    }
    if (!stream.paused) {
        return res.send(`${mount} is already playing`);
    }

    // check active transcodes to enforce the limit when resuming
    const activeCount = Object.values(activeStreams).filter(s => !s.paused).length;
    
    if (activeCount >= MAX_STREAMS) {
        if (!pauseLRUStream()) {
            return res.status(503).send('failed to free up a stream. please pause one manually.');
        }
    }

    stream.process = spawnFfmpeg(stream.uri, mount, stream.name, stream.description);
    stream.paused = false;
    stream.lastPlayedAt = Date.now();
    savestate(); // (or your updated promise-based save)
    res.send(`resumed ${mount}`);
});

app.post('/api/stop', (req, res) => {
    const { mount } = req.body;
    const stream = activeStreams[mount];

    if (!stream) {
        return res.send('stream was not running');
    }

    if (stream.process) {
        stream.process.kill();
    }
    delete activeStreams[mount];
    clearNowPlaying(mount);
    savestate();
    res.send(`stopped ${mount}`);
});

app.get('/', (req, res) => {
    res.send('wiiradio proxy is running!');
});

// load memory
loadstate();

app.listen(port, () => {
    console.log(`proxy webui listening on port ${port}`);
});
