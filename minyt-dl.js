const { createFFmpeg } = FFmpeg;
const ffmpeg = createFFmpeg({log: true});

const cors_proxy = "https://cors-anywhere.herokuapp.com"
const origin = "cors-anywhere.herokuapp.com"

let _url = "https://www.youtube.com/watch?v=ue201pjhHMI"

let _patterns = [
    new RegExp(';ytplayer\\.config\\s*=\\s*({.+?});ytplayer'),
    new RegExp(';ytplayer\\.config\\s*=\\s*({.+?});'),
];


let formatsDiv = document.getElementById("formatsDiv");
let containerDiv = document.getElementById("container");
let statusText = document.getElementById("statusText");

let streamingFormats = [];
let video_webpage;
let player_func = "";


function searchRegexes(patterns, string) {
    for (const p of patterns) {
        let mobj = string.match(p, "g");
        if (mobj)
            return mobj[1];
    }
    return null;
}



let _player_cache = {};
function signatureCacheId(example_sig) { return example_sig.split(".").map((x) => String(x.length)).join("."); }



async function extractSignatureFunction(player_url, s) {
    let resp = await fetch(cors_proxy + player_url);
    let code = await resp.text();

    let patterns = [
        new RegExp('\\b[cs]\\s*&&\\s*[adf]\\.set\\([^,]+\\s*,\\s*encodeURIComponent\\s*\\(\\s*([a-zA-Z0-9$]+)\\('),
        new RegExp('\\b[a-zA-Z0-9]+\\s*&&\\s*[a-zA-Z0-9]+\\.set\\([^,]+\\s*,\\s*encodeURIComponent\\s*\\(\\s*([a-zA-Z0-9$]+)\\('),
        new RegExp('(?:\\b|[^a-zA-Z0-9$])([a-zA-Z0-9$]{2})\\s*=\\s*function\\(\\s*a\\s*\\)\\s*{\\s*a\\s*=\\s*a\\.split\\(\\s*""\\s*\\)'),
        new RegExp('([a-zA-Z0-9$]+)\\s*=\\s*function\\(\\s*a\\s*\\)\\s*{\\s*a\\s*=\\s*a\\.split\\(\\s*""\\s*\\)'),
    ];

    
    let funcname = searchRegexes(patterns, code);

    if (funcname === "") {
        console.log("ERR: Funcname");
        return;
    }

    code = code.replace("})(_yt_player);", "g.Wu=Wu;})(_yt_player);")

    let script = document.createElement("script");
    script.text = code;
    document.head.appendChild(script);

    player_func = funcname;
}


async function decryptSignature(s, player_url) {
    let re = new RegExp('https?://');
    if (player_url.startsWith("//"))
        player_url = "https:" + player_url; 
    else if (!re.test(player_url)) 
        player_url = "https://www.youtube.com/" + player_url;
 
    if (player_func === "") {
         await extractSignatureFunction(player_url, s);
    }
    
    return window["_yt_player"][player_func](s);
}


async function get_formats(url) {
    let resp = await fetch(cors_proxy + url);
    video_webpage = await resp.text();

    let config = searchRegexes(_patterns, video_webpage);
    if (!config) {
        console.log("ERR: No Config");
        return;
    }

    let ytplayer_config = JSON.parse(config);
    let args = ytplayer_config.args;
    let player_response = JSON.parse(args.player_response);

    let simpleDiv = document.createElement("div");
    let audioSelect = document.createElement("select");
    let videoSelect = document.createElement("select");

    streamingFormats = player_response.streamingData.formats.concat(player_response.streamingData.adaptiveFormats);

    streamingFormats.forEach( (e, i) => {
        console.log("INFO");
        let spec = _formats[e.itag];

        if (spec.vcodec && spec.acodec) {
            let button = document.createElement("button");
            button.innerText = spec.height;
            
            button.onclick = () => { click(i); };
            simpleDiv.appendChild(button);
            return;
        }
        let option = document.createElement("option");
        option.value = i;

        if (spec.acodec) {    
            option.innerText = `${spec.acodec} - ${spec.abr}`;
            audioSelect.appendChild(option);
            return;
        }
        
        option.innerText = `${spec.vcodec} - ${spec.height}`;
        videoSelect.appendChild(option);
    });

    let muxButton = document.createElement("button");
    muxButton.innerText = "mux";
    muxButton.onclick = () => {
        mux(videoSelect.value, audioSelect.value);
    };

    formatsDiv.appendChild(simpleDiv);
    formatsDiv.appendChild(audioSelect);
    formatsDiv.appendChild(videoSelect);
    formatsDiv.appendChild(muxButton);
}


async function mux(videoId, audioId) {

    let vidUrl = await get_url(videoId);
    let audUrl = await get_url(audioId);

    function stat(s) {
        statusText.innerText = s;
    }
    stat("loading ffmpeg");
    await ffmpeg.load();

    stat("downloading video");
    let resp = await fetch(cors_proxy + vidUrl, { headers: {
        origin: origin,
    }});
    const contentEncoding = resp.headers.get('content-encoding');
    const contentLength = resp.headers.get(contentEncoding ? 'x-file-size' : 'content-length');
    const total = parseInt(contentLength, 10);
    let loaded = 0;
    function progress({loaded, total}) {
        stat(`Downloading ${((loaded/total)*100).toPrecision(3)}%`);
    }
    let video = await (await new Response(
        new ReadableStream({
            start(controller) {
                const reader = resp.body.getReader();

                read();
                function read() {
                    reader.read().then(({done, value}) => {
                        if (done) {
                            controller.close();
                            return;
                        }
                        loaded += value.byteLength;
                        progress({loaded, total});
                        controller.enqueue(value);
                        read();
                    });
                }
            }
        }))).blob();

    stat("downloading audio");
    resp = await fetch(cors_proxy + audUrl, { headers: {
        origin: origin,
    }});
    let audio = await resp.blob();

    stat("marshalling video");
    await ffmpeg.write("video.mp4", video);

    stat("marshalling audio");
    await ffmpeg.write("audio.aac", audio);

    stat("muxing");
    await ffmpeg.run("-i video.mp4 -i audio.aac -c:v copy -c:a copy out.mp4");

    stat("cleaning up");
    await ffmpeg.remove("video.mp4");
    await ffmpeg.remove("audio.aac");

    stat("retrieving");
    const out = ffmpeg.read("out.mp4");

    stat("done");
    saveAs(new Blob([out]), "out.mp4");
}


async function get_url(i) {
    let fmt = streamingFormats[i];
    let cipher = fmt.cipher || fmt.signatureCipher;
    let url_data = new URLSearchParams(cipher);
    let url = url_data.get("url");
    let player_url;

    if (!url)
        return;

    if (url_data.has("s")) {
        let ASSETS_RE = new RegExp('"assets":.+?"js":\\s*("[^"]+")');
        let jsplayer_url_json = video_webpage.match(ASSETS_RE)[1];
        if (!jsplayer_url_json)
            return;
        player_url = JSON.parse(jsplayer_url_json);
    }

    if (url_data.has("sig"))
        url += `&signature=${url_data.get("sig")}`;
    else if (url_data.has("s")) {
        let encrypted_sig = url_data.get("s");
        let signature = await decryptSignature(encrypted_sig, player_url);
        url += `&${url_data.get("sp") || "signature"}=${signature}`;
    }

    return url;
}


async function click(i) {
    let url = await get_url(i);

    let media = document.createElement("video");
    media.src = url;
    media.controls = true;
    media.height = 480;

    containerDiv.textContent = '';
    containerDiv.appendChild(media);
}

get_formats(_url);




let _formats = {
        '5': {'ext': 'flv', 'width': 400, 'height': 240, 'acodec': 'mp3', 'abr': 64, 'vcodec': 'h263'},
        '6': {'ext': 'flv', 'width': 450, 'height': 270, 'acodec': 'mp3', 'abr': 64, 'vcodec': 'h263'},
        '13': {'ext': '3gp', 'acodec': 'aac', 'vcodec': 'mp4v'},
        '17': {'ext': '3gp', 'width': 176, 'height': 144, 'acodec': 'aac', 'abr': 24, 'vcodec': 'mp4v'},
        '18': {'ext': 'mp4', 'width': 640, 'height': 360, 'acodec': 'aac', 'abr': 96, 'vcodec': 'h264'},
        '22': {'ext': 'mp4', 'width': 1280, 'height': 720, 'acodec': 'aac', 'abr': 192, 'vcodec': 'h264'},
        '34': {'ext': 'flv', 'width': 640, 'height': 360, 'acodec': 'aac', 'abr': 128, 'vcodec': 'h264'},
        '35': {'ext': 'flv', 'width': 854, 'height': 480, 'acodec': 'aac', 'abr': 128, 'vcodec': 'h264'},
        // itag 36 videos are either 320x180 (BaW_jenozKc) or 320x240 (__2ABJjxzNo), abr varies as well
        '36': {'ext': '3gp', 'width': 320, 'acodec': 'aac', 'vcodec': 'mp4v'},
        '37': {'ext': 'mp4', 'width': 1920, 'height': 1080, 'acodec': 'aac', 'abr': 192, 'vcodec': 'h264'},
        '38': {'ext': 'mp4', 'width': 4096, 'height': 3072, 'acodec': 'aac', 'abr': 192, 'vcodec': 'h264'},
        '43': {'ext': 'webm', 'width': 640, 'height': 360, 'acodec': 'vorbis', 'abr': 128, 'vcodec': 'vp8'},
        '44': {'ext': 'webm', 'width': 854, 'height': 480, 'acodec': 'vorbis', 'abr': 128, 'vcodec': 'vp8'},
        '45': {'ext': 'webm', 'width': 1280, 'height': 720, 'acodec': 'vorbis', 'abr': 192, 'vcodec': 'vp8'},
        '46': {'ext': 'webm', 'width': 1920, 'height': 1080, 'acodec': 'vorbis', 'abr': 192, 'vcodec': 'vp8'},
        '59': {'ext': 'mp4', 'width': 854, 'height': 480, 'acodec': 'aac', 'abr': 128, 'vcodec': 'h264'},
        '78': {'ext': 'mp4', 'width': 854, 'height': 480, 'acodec': 'aac', 'abr': 128, 'vcodec': 'h264'},


        // 3D videos
        '82': {'ext': 'mp4', 'height': 360, 'format_note': '3D', 'acodec': 'aac', 'abr': 128, 'vcodec': 'h264', 'preference': -20},
        '83': {'ext': 'mp4', 'height': 480, 'format_note': '3D', 'acodec': 'aac', 'abr': 128, 'vcodec': 'h264', 'preference': -20},
        '84': {'ext': 'mp4', 'height': 720, 'format_note': '3D', 'acodec': 'aac', 'abr': 192, 'vcodec': 'h264', 'preference': -20},
        '85': {'ext': 'mp4', 'height': 1080, 'format_note': '3D', 'acodec': 'aac', 'abr': 192, 'vcodec': 'h264', 'preference': -20},
        '100': {'ext': 'webm', 'height': 360, 'format_note': '3D', 'acodec': 'vorbis', 'abr': 128, 'vcodec': 'vp8', 'preference': -20},
        '101': {'ext': 'webm', 'height': 480, 'format_note': '3D', 'acodec': 'vorbis', 'abr': 192, 'vcodec': 'vp8', 'preference': -20},
        '102': {'ext': 'webm', 'height': 720, 'format_note': '3D', 'acodec': 'vorbis', 'abr': 192, 'vcodec': 'vp8', 'preference': -20},

        // Apple HTTP Live Streaming
        '91': {'ext': 'mp4', 'height': 144, 'format_note': 'HLS', 'acodec': 'aac', 'abr': 48, 'vcodec': 'h264', 'preference': -10},
        '92': {'ext': 'mp4', 'height': 240, 'format_note': 'HLS', 'acodec': 'aac', 'abr': 48, 'vcodec': 'h264', 'preference': -10},
        '93': {'ext': 'mp4', 'height': 360, 'format_note': 'HLS', 'acodec': 'aac', 'abr': 128, 'vcodec': 'h264', 'preference': -10},
        '94': {'ext': 'mp4', 'height': 480, 'format_note': 'HLS', 'acodec': 'aac', 'abr': 128, 'vcodec': 'h264', 'preference': -10},
        '95': {'ext': 'mp4', 'height': 720, 'format_note': 'HLS', 'acodec': 'aac', 'abr': 256, 'vcodec': 'h264', 'preference': -10},
        '96': {'ext': 'mp4', 'height': 1080, 'format_note': 'HLS', 'acodec': 'aac', 'abr': 256, 'vcodec': 'h264', 'preference': -10},
        '132': {'ext': 'mp4', 'height': 240, 'format_note': 'HLS', 'acodec': 'aac', 'abr': 48, 'vcodec': 'h264', 'preference': -10},
        '151': {'ext': 'mp4', 'height': 72, 'format_note': 'HLS', 'acodec': 'aac', 'abr': 24, 'vcodec': 'h264', 'preference': -10},

        // DASH mp4 video
        '133': {'ext': 'mp4', 'height': 240, 'format_note': 'DASH video', 'vcodec': 'h264'},
        '134': {'ext': 'mp4', 'height': 360, 'format_note': 'DASH video', 'vcodec': 'h264'},
        '135': {'ext': 'mp4', 'height': 480, 'format_note': 'DASH video', 'vcodec': 'h264'},
        '136': {'ext': 'mp4', 'height': 720, 'format_note': 'DASH video', 'vcodec': 'h264'},
        '137': {'ext': 'mp4', 'height': 1080, 'format_note': 'DASH video', 'vcodec': 'h264'},
        '138': {'ext': 'mp4', 'format_note': 'DASH video', 'vcodec': 'h264'},  // Height can vary (https://github.com/ytdl-org/youtube-dl/issues/4559)
        '160': {'ext': 'mp4', 'height': 144, 'format_note': 'DASH video', 'vcodec': 'h264'},
        '212': {'ext': 'mp4', 'height': 480, 'format_note': 'DASH video', 'vcodec': 'h264'},
        '264': {'ext': 'mp4', 'height': 1440, 'format_note': 'DASH video', 'vcodec': 'h264'},
        '298': {'ext': 'mp4', 'height': 720, 'format_note': 'DASH video', 'vcodec': 'h264', 'fps': 60},
        '299': {'ext': 'mp4', 'height': 1080, 'format_note': 'DASH video', 'vcodec': 'h264', 'fps': 60},
        '266': {'ext': 'mp4', 'height': 2160, 'format_note': 'DASH video', 'vcodec': 'h264'},

        // Dash mp4 audio
        '139': {'ext': 'm4a', 'format_note': 'DASH audio', 'acodec': 'aac', 'abr': 48, 'container': 'm4a_dash'},
        '140': {'ext': 'm4a', 'format_note': 'DASH audio', 'acodec': 'aac', 'abr': 128, 'container': 'm4a_dash'},
        '141': {'ext': 'm4a', 'format_note': 'DASH audio', 'acodec': 'aac', 'abr': 256, 'container': 'm4a_dash'},
        '256': {'ext': 'm4a', 'format_note': 'DASH audio', 'acodec': 'aac', 'container': 'm4a_dash'},
        '258': {'ext': 'm4a', 'format_note': 'DASH audio', 'acodec': 'aac', 'container': 'm4a_dash'},
        '325': {'ext': 'm4a', 'format_note': 'DASH audio', 'acodec': 'dtse', 'container': 'm4a_dash'},
        '328': {'ext': 'm4a', 'format_note': 'DASH audio', 'acodec': 'ec-3', 'container': 'm4a_dash'},

        // Dash webm
        '167': {'ext': 'webm', 'height': 360, 'width': 640, 'format_note': 'DASH video', 'container': 'webm', 'vcodec': 'vp8'},
        '168': {'ext': 'webm', 'height': 480, 'width': 854, 'format_note': 'DASH video', 'container': 'webm', 'vcodec': 'vp8'},
        '169': {'ext': 'webm', 'height': 720, 'width': 1280, 'format_note': 'DASH video', 'container': 'webm', 'vcodec': 'vp8'},
        '170': {'ext': 'webm', 'height': 1080, 'width': 1920, 'format_note': 'DASH video', 'container': 'webm', 'vcodec': 'vp8'},
        '218': {'ext': 'webm', 'height': 480, 'width': 854, 'format_note': 'DASH video', 'container': 'webm', 'vcodec': 'vp8'},
        '219': {'ext': 'webm', 'height': 480, 'width': 854, 'format_note': 'DASH video', 'container': 'webm', 'vcodec': 'vp8'},
        '278': {'ext': 'webm', 'height': 144, 'format_note': 'DASH video', 'container': 'webm', 'vcodec': 'vp9'},
        '242': {'ext': 'webm', 'height': 240, 'format_note': 'DASH video', 'vcodec': 'vp9'},
        '243': {'ext': 'webm', 'height': 360, 'format_note': 'DASH video', 'vcodec': 'vp9'},
        '244': {'ext': 'webm', 'height': 480, 'format_note': 'DASH video', 'vcodec': 'vp9'},
        '245': {'ext': 'webm', 'height': 480, 'format_note': 'DASH video', 'vcodec': 'vp9'},
        '246': {'ext': 'webm', 'height': 480, 'format_note': 'DASH video', 'vcodec': 'vp9'},
        '247': {'ext': 'webm', 'height': 720, 'format_note': 'DASH video', 'vcodec': 'vp9'},
        '248': {'ext': 'webm', 'height': 1080, 'format_note': 'DASH video', 'vcodec': 'vp9'},
        '271': {'ext': 'webm', 'height': 1440, 'format_note': 'DASH video', 'vcodec': 'vp9'},
        // itag 272 videos are either 3840x2160 (e.g. RtoitU2A-3E) or 7680x4320 (sLprVF6d7Ug)
        '272': {'ext': 'webm', 'height': 2160, 'format_note': 'DASH video', 'vcodec': 'vp9'},
        '302': {'ext': 'webm', 'height': 720, 'format_note': 'DASH video', 'vcodec': 'vp9', 'fps': 60},
        '303': {'ext': 'webm', 'height': 1080, 'format_note': 'DASH video', 'vcodec': 'vp9', 'fps': 60},
        '308': {'ext': 'webm', 'height': 1440, 'format_note': 'DASH video', 'vcodec': 'vp9', 'fps': 60},
        '313': {'ext': 'webm', 'height': 2160, 'format_note': 'DASH video', 'vcodec': 'vp9'},
        '315': {'ext': 'webm', 'height': 2160, 'format_note': 'DASH video', 'vcodec': 'vp9', 'fps': 60},

        // Dash webm audio
        '171': {'ext': 'webm', 'acodec': 'vorbis', 'format_note': 'DASH audio', 'abr': 128},
        '172': {'ext': 'webm', 'acodec': 'vorbis', 'format_note': 'DASH audio', 'abr': 256},

        // Dash webm audio with opus inside
        '249': {'ext': 'webm', 'format_note': 'DASH audio', 'acodec': 'opus', 'abr': 50},
        '250': {'ext': 'webm', 'format_note': 'DASH audio', 'acodec': 'opus', 'abr': 70},
        '251': {'ext': 'webm', 'format_note': 'DASH audio', 'acodec': 'opus', 'abr': 160},

        // RTMP (unnamed)
        '_rtmp': {'protocol': 'rtmp'},

        // av01 video only formats sometimes served with "unknown" codecs
        '394': {'acodec': 'none', 'vcodec': 'av01.0.05M.08'},
        '395': {'acodec': 'none', 'vcodec': 'av01.0.05M.08'},
        '396': {'acodec': 'none', 'vcodec': 'av01.0.05M.08'},
        '397': {'acodec': 'none', 'vcodec': 'av01.0.05M.08'},
    }