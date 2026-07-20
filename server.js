const express = require('express');
const { spawn } = require('child_process');
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

function spawnFfmpeg(sourceUri, mount, streamName, streamDesc) {
    const args = [
        '-i', sourceUri,
        '-c:a', 'libmp3lame',
        '-b:a', '128k',
        '-ar', '44100',
        '-ac', '2',
        '-content_type', 'audio/mpeg',
        '-map_metadata', '0',   // try to carry over track title tags
        '-id3v2_version', '3',
        '-f', 'mp3',
        '-ice_name', streamName,
        '-ice_description', streamDesc,
        // VVV EDIT THE PASSWORD HERE VVV
        `icecast://source:password@icecast-server:8000/${mount}`
    ];

    const ffmpegProcess = spawn('ffmpeg', args);

    ffmpegProcess.stderr.on('data', (data) => {
        console.log(`[${mount}] ffmpeg: ${data.toString().trim()}`);
    });

    ffmpegProcess.on('close', (code) => {
        console.log(`[${mount}] ffmpeg exited with code ${code}`);

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

function mountIdFromName(name) {
    return name.trim().replace(/\s+/g, '-').toLowerCase();
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

    const plsContent = `[playlist]
NumberOfEntries=1
File1=http://${hostIp}:4000/${mount}
Title1=${mount}
Length1=-1
Version=2`;

    res.set('Content-Type', 'audio/x-scpls');
    res.set('Content-Disposition', `attachment; filename="${mount}.pls"`);
    res.send(plsContent);
});

app.post('/api/start', (req, res) => {
    const { uri, name, description } = req.body;

    if (!name || !uri) {
        return res.status(400).send('name and uri are required');
    }

    const mount = mountIdFromName(name);

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
