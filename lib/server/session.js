var id_count = 0,
    sessions = {},
    Rudeplay = null,
    stream   = require('stream'),
    Blast    = __Protoblast,
    Fn       = Blast.Bound.Function;

Rudeplay = Fn.getNamespace('Develry.Rudeplay');

var Speaker = require('speaker');

/**
 * The Server Session class
 *
 * @author   Jelle De Loecker   <jelle@develry.be>
 * @since    0.1.0
 * @version  0.2.0
 *
 * @param    {Incoming}   req   The incoming request
 */
var Session = Fn.inherits('Develry.Rudeplay.Common.Session', 'Develry.Rudeplay.Server', function Session(req) {

	var that = this;

	Session.super.call(this, req);

	// Store the main server instance
	this.rudeplay = req.connection.rudeplay;

	// Specific RTP info, received through RECORD
	this.rtp_info = null;

	// Server instances will go here later
	this.rtp_server = null;
	this.rtp_control_server = null;
	this.timing_server = null;

	// The initial RTP timestamp number
	// This is always given to us by the client, and is a random number
	this.initial_rtp_timestamp = 0;

	// Sequence number corresponding to the initial timestamp
	this.initial_seq_timestamp = 0;

	// Re-transmit callbacks
	this.retransmit_callbacks = new Map();

	// The codec
	this.codec = 'pcm';

	this._control_seq_nr = 1;

	if (this.rudeplay.settings.software_volume) {
		// Create the volume stream
		this._volume_transform = new Rudeplay.Server.VolumeStream();
	}

	if (this.rudeplay.settings.output_to_speaker) {
		// Create a speaker instance
		this.speaker = new Speaker({
			channels: 2,          // 2 channels 
			bitDepth: 16,         // 16-bit samples 
			sampleRate: 44100,    // 44,100 Hz sample rate 
			samplesPerFrame: 128
		});
	}

	// Pipe volume output into the speaker
	if (this._volume_transform) {
		this._volume_transform.pipe(this.speaker);
	}

	// Create an RTSP sequence stream
	this.recreateRtspSequence();

	// Inform rudeplay a new session has been created
	this.rudeplay.emit('session', this);
});

/**
 * Reset the session, called by TEARDOWN request
 *
 * @author   Jelle De Loecker   <jelle@develry.be>
 * @since    0.1.2
 * @version  0.1.2
 */
Session.setMethod(function reset() {

	// We don't have to destroy the session,
	// the stream just needs to stop playing
	// The session queue also needs to be reset
	this.recreateRtspSequence();

	// Reset the initial timestamps
	this.initial_rtp_timestamp = 0;
	this.initial_seq_timestamp = 0;
});

/**
 * Set the SDP info
 *
 * @author   Jelle De Loecker   <jelle@develry.be>
 * @since    0.2.0
 * @version  0.2.0
 */
Session.setMethod(function setSdp(conf) {

	var codec,
	    pair,
	    fmtp,
	    key,
	    obj,
	    iv,
	    i;

	if (Blast.DEBUG) {
		Rudeplay.log('Got raw SDP:', conf, conf.media[0]);
	}

	if (conf.media[0].fmtp[0]) {
		// fmtp:96 352 0 16 40 10 14 2 255 0 0 44100
		fmtp = conf.media[0].fmtp[0].config.split(' ');

		// for detailed info about the ALAC cookie, see:
		// https://alac.macosforge.org/trac/browser/trunk/ALACMagicCookieDescription.txt
		conf.alac = {
			frameLength       : parseInt(fmtp[0], 10),   // 32 bit
			compatibleVersion : parseInt(fmtp[1], 10),   // 8 bit
			bitDepth          : parseInt(fmtp[2], 10),   // 8 bit
			pb                : parseInt(fmtp[3], 10),   // 8 bit
			mb                : parseInt(fmtp[4], 10),   // 8 bit
			kb                : parseInt(fmtp[5], 10),   // 8 bit
			channels          : parseInt(fmtp[6], 10),   // 8 bit
			maxRun            : parseInt(fmtp[7], 10),   // 16 bit
			maxFrameBytes     : parseInt(fmtp[8], 10),   // 32 bit
			avgBitRate        : parseInt(fmtp[9], 10),   // 32 bit
			sampleRate        : parseInt(fmtp[10], 10)   // 32 bit
		};

		this.codec = 'alac';
	} else {
		this.codec = 'pcm';
	}

	// Store the SDP configuration in the session
	this.set('sdp_conf', conf);

	if (Blast.DEBUG) {
		Rudeplay.log('Normalized SDP:', conf);
	}

	if (conf.media && conf.media[0] && conf.media[0].invalid) {
		for (i = 0; i < conf.media[0].invalid.length; i++) {
			obj = conf.media[0].invalid[i];
			pair = obj.value.split(':');

			switch (pair[0]) {

				case 'rsaaeskey':
					key = pair[1];
					break;

				case 'aesiv':
					iv = pair[1];
					break;

				case 'rtpmap':
					codec = pair[1];

					if (codec.indexOf('L16') === -1 && codec.indexOf('AppleLossless') === -1) {
						return 415;
					}

					this.set('audio_codec', codec);
					break;

				case 'fmtp':
					break;
			}
		};
	} else if (conf.media && conf.media[0].rtp && conf.media[0].rtp[0]) {
		// Should really iterate, but we're just testing our own Rudeplay client for now
		obj = conf.media[0].rtp[0];
		codec = obj.codec || '';

		if (codec.indexOf('L16') === -1 && codec.indexOf('AppleLossless') === -1) {
			return 415;
		}

		this.set('audio_codec', codec);
	}

	if (conf.connection.version == 6) {
		this.is_ipv6 = true;
	}

	// It's possible that no encryption is used, in case of another non-airtunes client
	if (key) {
		conf.aeskey = that.rudeplay.apple_key.decrypt(new Buffer(key, 'base64').toString('binary'), 'RSA-OAEP');
		conf.aesiv = new Buffer(iv, 'base64');
	}
});

/**
 * Create a new Rtsp Sequence stream
 *
 * @author   Jelle De Loecker   <jelle@develry.be>
 * @since    0.1.0
 * @version  0.1.0
 */
Session.setMethod(function recreateRtspSequence() {

	var that = this;

	// If there is a current sequence, reset it
	if (this.rtsp_sequence) {
		// Reset the existing stream's sequence queue
		this.rtsp_sequence._sequeue.reset();
	}

	// Destroy any existing request queues
	if (this.request_queue) {
		this.request_queue.destroy();
	}

	// Create a new function queue
	// Allow 10 concurrent requests, throttle new ones at 5ms
	// Without a queue, requests were made at +/- 25/s, and it couldn't keep up
	this.request_queue = Fn.createQueue({limit: 10, throttle: 5, enabled: true});

	// Create new stream sequence
	this.rtsp_sequence = new Rudeplay.Server.RtspSequenceStream(this, {timeout: this.rudeplay.retransmit_timeout});

	// Re-request missing packets
	this.rtsp_sequence.on('missing', function onMissing(seq, callback) {
		// Schedule this request
		that.request_queue.add(function doRequest(next) {
			// Next is called when request has been sent,
			// callback will receive the actual response
			that._retransmit(seq, next, callback);
		});
	});
});

/**
 * Add a chunk to the RTSP sequence stream
 *
 * @author   Thomas Watson Steen   <w@tson.dk> 
 * @author   Jelle De Loecker   <jelle@develry.be>
 * @since    0.1.0
 * @version  0.1.0
 *
 * @param    {Number}   seq
 * @param    {Buffer}   chunk
 */
Session.setMethod(function addSequence(seq, chunk) {
	return this.rtsp_sequence.add(seq, chunk);
});

/**
 * Create an AlacDecoder stream
 *
 * @author   Jelle De Loecker   <jelle@develry.be>
 * @since    0.1.0
 * @version  0.1.3
 *
 * @return   {AlacDecoderStream}
 */
Session.setMethod(function createDecoder() {

	var that = this,
	    target;

	// Create the decoder stream
	this.decoder_stream = new (Rudeplay.Formats.getDecoder(this.codec))({session: this});

	if (this._volume_transform) {
		target = this._volume_transform;
	} else if (this.speaker) {
		target = this.speaker;
	}

	// Pipe the decoder into the volume stream or speaker, if set
	if (target) {
		this.decoder_stream.pipe(target);
	}

	if (Blast.DEBUG) {
		Rudeplay.log(this.decoder_stream.constructor.name, 'will pipe into', target);
	}

	this.rtsp_sequence.on('data', function(chunk) {

		if (Blast.DEBUG && chunk.length < 110) {
			console.log('Got chunk smaller than 110 bytes');
		}

		that.decoder_stream.write(chunk);
	})

	// Pipe the RTSP sequence output into the ALAC decoder
	//this.rtsp_sequence.pipe(this.decoder_stream);

	// Emit this new decoder stream and its session
	this.rudeplay.emit('decoder_stream', this.decoder_stream, this);

	return this.decoder_stream;
});

/**
 * Request sequence retransmit
 *
 * @author   Thomas Watson Steen   <w@tson.dk> 
 * @author   Jelle De Loecker   <jelle@develry.be>
 * @since    0.1.0
 * @version  0.1.1
 *
 * @param    {Number}   seq                 The sequence number to request
 * @param    {Function} sent_callback       Function to call when request has been sent
 * @param    {Function} response_callback   Function to call with response
 */
Session.setMethod(function _retransmit(seq, sent_callback, response_callback) {

	var that = this,
	    control_nr,
	    client,
	    buf;

	// Get the control number
	//control_nr = this._control_seq_nr++;

	buf = new Buffer(8);

	// The marker is always on: 0x80
	buf.writeUInt8(128, 0);

	// 85 = Apple 'retransmit' query
	// 0xd5
	buf.writeUInt8(128 + 85, 1);

	// The sequence number is always 1,
	// so control_nr is no longer needed?
	buf.writeUInt16BE(1, 2);

	// Actual sequence number we need
	buf.writeUInt16BE(seq, 4);

	// Count of sequences we need
	buf.writeUInt16BE(1, 6);

	// Buffer example of re-requesting seq 22503 as control 0
	// <Buffer 80 d5 00 00 57 e7 00 02>

	if (Blast.DEBUG) {
		Rudeplay.log('Requesting client to re-transmit', seq);
	}

	this.retransmit_callbacks.set(seq, response_callback);

	// It is important to send the retransmit request from the same port as the one you're receiving the responses on
	// Itunes and such will IGNORE the control_port you originally told it about, and send the retransmit response
	// to the same port as from where the query was made.
	this.rtp_control_server.server.send(buf, 0, 8, this.client_transport.control_port, this.rtp_server.remote_info.address, sent_callback);
});

/**
 * Set Rtp info
 * Should be received on a RECORD request (to set up info, though it isn't)
 * and on a FLUSH request (to pause it)
 *
 * @author   Jelle De Loecker     <jelle@develry.be>
 * @since    0.1.0
 * @version  0.1.0
 *
 * @param    {String|Object}   info   String coming from request headers, or object
 */
Session.setMethod(function setRtpInfo(info) {

	// Turn the info into an object
	if (typeof info == 'string') {
		info = this.original_req.splitHeaderLine(info);
	}

	// Get the sequence number
	info.seq = parseInt(info.seq, 10);

	this.setInitialTimestamp(Number(info.rtptime), info.seq);

	// Set the general info
	this.rtp_info = info;

	if (Blast.DEBUG) {
		Rudeplay.log('RTP info:', info, 'initial RTP time:', this.initial_rtp_timestamp);
	}
});

/**
 * Set the initial RTP timestamp
 *
 * @author   Jelle De Loecker     <jelle@develry.be>
 * @since    0.1.0
 * @version  0.1.0
 *
 * @param    {Number}   time   The initial RTP timestamp
 * @param    {Number}   seq    The optional seq number corresponding to it
 */
Session.setMethod(function setInitialTimestamp(time, seq) {

	// Initial timestamp can't be 0 or anything false
	if (!time) {
		return;
	}

	if (Blast.DEBUG) {
		Rudeplay.log('Setting initial timestamps:', time, 'Seq:', seq);
	}

	// Set the initial timestamp
	this.initial_rtp_timestamp = time;

	if (seq) {
		this.initial_seq_timestamp = seq;
	}
});

/**
 * Set Rtp server
 *
 * @author   Jelle De Loecker     <jelle@develry.be>
 * @since    0.1.0
 * @version  0.1.0
 */
Session.setMethod(function setRtpServer(server) {
	this.rtp_server = server;
});

/**
 * Set Rtp Control server
 *
 * @author   Jelle De Loecker     <jelle@develry.be>
 * @since    0.1.0
 * @version  0.1.0
 */
Session.setMethod(function setRtpControlServer(server) {
	this.rtp_control_server = server;
});