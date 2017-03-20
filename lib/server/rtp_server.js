var Rudeplay = null,
    stream   = require('stream'),
    dgram    = require('dgram'),
    Blast    = __Protoblast,
    util     = require('util'),
    fs       = require('fs'),
    Fn       = Blast.Bound.Function;

Rudeplay = Fn.getNamespace('Develry.Rudeplay');

/**
 * The RTP server class
 * Actual media data will be sent to this server
 *
 * @author   Jelle De Loecker   <jelle@develry.be>
 * @since    0.1.0
 * @version  0.2.0
 *
 * @param    {Incoming}   req   The incoming request
 */
var RtpServer = Fn.inherits('Informer', 'Develry.Rudeplay.Server', function RtpServer(req) {

	var that = this,
	    marker = true,
	    conf;

	// Store the main server instance
	this.rudeplay = req.connection.rudeplay;

	// Store the connection
	this.connection = req.connection;

	// Original request
	this.req = req;

	// Session
	this.session = req.session;

	// Store this in the session
	this.session.setRtpServer(this);

	// Remote info goes here later
	this.remote_info = null;

	// Create a dgram server
	this.server = dgram.createSocket(this.session.socket_type);

	// Listen for messages
	this.server.on('message', function gotRtpMessage(msg, remote_info) {

		var body,
		    time,
		    seq;

		if (marker) {
			that.remote_info = remote_info;
			marker = false;
		}

		if (!conf) {
			conf = req.session.get('sdp_conf');

			// From node v6.0.0 onwards the key is handled differently,
			// we need to use a buffer
			if (typeof conf.aeskey == 'string') {
				conf.aeskey = Buffer.from(conf.aeskey, 'binary');
			}
		}

		if (!conf) {
			throw new Error('Could not find SDP configuration for decrypting incoming RTP data');
		}

		// Get the sequence number
		seq = msg.readUInt16BE(2);

		// Set the initial timestamp if needed
		if (req.session.initial_rtp_timestamp == 0) {

			// Get the timestamp
			time = msg.readUInt32BE(4);

			// Set the initial timestamp
			req.session.setInitialTimestamp(time - req.session.framelength, seq - 1);
		}

		if (Blast.DEBUG) {
			if (seq % 50 == 0) {
				Rudeplay.log('SEQ:', seq - req.session.initial_seq_timestamp, 'Time:', msg.readUInt32BE(4), 'Length:', msg.length);
			}
		}

		if (conf.aeskey) {
			// Decrypt the data (and slice of the header)
			body = that.rudeplay.decryptData(msg, conf.aeskey, conf.aesiv);
		} else {
			// Just slice of the header
			body = msg.slice(12);
		}

		req.session.addSequence(seq, body);
	});

	// Original port: 53561
	// Some RAOP clients will be hardcoded to connect to 5000,
	// like VLC. So that won't work.
	// Bind to any available port
	this.server.bind(function bound() {
		var addr = that.server.address();

		if (Blast.DEBUG) {
			Rudeplay.log('RTP server listening', addr.port);
		}

		that.emit('ready', addr.port);
		that.emit('done', null, addr.port);
	});
});

/**
 * The session property
 *
 * @author   Jelle De Loecker   <jelle@develry.be>
 * @since    0.1.0
 * @version  0.1.0
 *
 * @type     {Session}
 */
RtpServer.setProperty(function session() {
	return this.req.session;
});

/**
 * Destroy the server
 *
 * @author   Jelle De Loecker   <jelle@develry.be>
 * @since    0.1.0
 * @version  0.1.0
 */
RtpServer.setMethod(function destroy() {
	this.server.close();
});

module.exports = RtpServer;