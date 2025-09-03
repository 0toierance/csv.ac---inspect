const winston = global.winston || require('winston'),
    SteamUser = require('steam-user'),
    GlobalOffensive = require('globaloffensive'),
    SteamTotp = require('steam-totp'),
    EventEmitter = require('events').EventEmitter;

class Bot extends EventEmitter {
    /**
     * Sets the ready status and sends a 'ready' or 'unready' event if it has changed
     * @param {*|boolean} val New ready status
     */
    set ready(val) {
        const prev = this.ready;
        this.ready_ = val;

        if (val !== prev) {
            this.emit(val ? 'ready' : 'unready');
        }
    }

    /**
     * Returns the current ready status
     * @return {*|boolean} Ready status
     */
    get ready() {
        return this.ready_ || false;
    }

    constructor(settings) {
        super();

        this.settings = settings;
        this.busy = false;
        this.user = null;  // Will be set during login
        this.needsSteamGuard = false;

        this.steamClient = new SteamUser(Object.assign({
            promptSteamGuardCode: false,
            enablePicsCache: true // Required to check if we own CSGO with ownsApp
        }, this.settings.steam_user));

        this.csgoClient = new GlobalOffensive(this.steamClient);

        // set up event handlers
        this.bindEventHandlers();

        // Variance to apply so that each bot relogins at different times
        const variance = parseInt(Math.random() * 4 * 60 * 1000);

        // As of 7/10/2020, GC inspect calls can timeout repeatedly for whatever reason
        setInterval(() => {
            if (this.csgoClient.haveGCSession) {
                this.relogin = true;
                this.steamClient.relog();
            }
        }, 30 * 60 * 1000 + variance);

        // Disabled aggressive 5-minute reconnection - was causing connection instability
        // Proxy sessions typically last 15 minutes, only the 30-minute GC reconnect should be needed
        // If proxy rotation is needed, it should be increased to at least 15 minutes
        /*
        const proxyVariance = parseInt(Math.random() * 30 * 1000); // 0-30 seconds variance
        setInterval(() => {
            winston.debug(`${this.username} performing proxy session refresh`);
            if (this.steamClient.steamID) {
                this.relogin = true;
                this.steamClient.relog();
            }
        }, 5 * 60 * 1000 + proxyVariance);
        */
    }

    logIn(username, password, auth, steamGuardCode = null) {
        this.ready = false;

        // Save these parameters if we login later
        if (arguments.length >= 3) {
            this.username = username;
            this.user = username;  // Store for proxy pool manager
            this.password = password;
            this.auth = auth;
        }

        winston.info(`Logging in ${this.username}`);

        // If there is a steam client, make sure it is disconnected
        if (this.steamClient) this.steamClient.logOff();

        this.loginData = {
            accountName: this.username,
            password: this.password,
            rememberPassword: true,
        };

        // Handle Steam Guard code if provided as parameter
        if (steamGuardCode) {
            winston.info(`${this.username} using provided Steam Guard code`);
            this.loginData.authCode = steamGuardCode;
            this.needsSteamGuard = false;
        } else if (this.auth && this.auth !== '') {
            // Check if it is a shared_secret
            if (this.auth.length <= 5) {
                this.loginData.authCode = this.auth;
                winston.info(`${this.username} Using static auth code from config`);
            } else {
                // Generate the code from the shared_secret
                winston.debug(`${this.username} Generating TOTP Code from shared_secret`);
                try {
                    this.loginData.twoFactorCode = SteamTotp.getAuthCode(this.auth);
                } catch (e) {
                    winston.error(`${this.username} Failed to generate TOTP code: ${e.message}`);
                }
            }
        }

        winston.debug(`${this.username} About to connect`);
        this.steamClient.logOn(this.loginData);
    }

    bindEventHandlers() {
        // Handle Steam Guard code prompts
        this.steamClient.on('steamGuard', (domain, callback, lastCodeWrong) => {
            winston.warn(`${this.username} got Steam Guard prompt (domain: ${domain}, lastCodeWrong: ${lastCodeWrong})`);
            // Don't provide a code, instead emit loginFailed to trigger retry
            // These accounts don't actually have Steam Guard, it's a false positive
            this.emit('loginFailed', new Error('Steam Guard prompt - false positive'), 'steamguard');
            // Disconnect to properly abort the login attempt
            this.steamClient.logOff();
            // Don't call the callback - we're aborting
        });

        this.steamClient.on('error', (err) => {
            winston.error(`Error logging in ${this.username}:`, err);

            let login_error_msgs = {
                61: 'Invalid Password',
                63: 'Account login denied due to 2nd factor authentication failure. ' +
                    'If using email auth, an email has been sent.',
                65: 'Account login denied due to auth code being invalid',
                66: 'Account login denied due to 2nd factor auth failure and no mail has been sent',
                84: 'Rate limit exceeded, try again later'
            };

            if (err.eresult && login_error_msgs[err.eresult] !== undefined) {
                winston.error(this.username + ': ' + login_error_msgs[err.eresult]);
            }

            // Categorize the error
            const errorString = err.toString();
            const isProxyError = errorString.includes('Proxy connection timed out') ||
                               errorString.includes('ETIMEDOUT') ||
                               errorString.includes('ECONNREFUSED') ||
                               errorString.includes('ECONNRESET') ||
                               errorString.includes('Proxy') ||
                               errorString.includes('500 Internal Server Error') ||
                               errorString.includes('self-signed certificate') ||
                               errorString.includes('Request timed out');  // Add timeout errors
            
            const isSteamGuardError = err.eresult && [63, 65].includes(err.eresult);
            const isAuthError = err.eresult && [61, 66].includes(err.eresult);
            const isRateLimitError = err.eresult === 84 || 
                                   err.eresult === 87 ||  // AccountLoginDeniedThrottle
                                   errorString.includes('RateLimitExceeded') ||
                                   errorString.includes('AccountLoginDeniedThrottle');
            
            // Log the error categorization for debugging
            winston.debug(`${this.username} error categorized - Proxy: ${isProxyError}, SteamGuard: ${isSteamGuardError}, Auth: ${isAuthError}, RateLimit: ${isRateLimitError}`);
            
            // Handle different error types
            if (isSteamGuardError) {
                // Treat Steam Guard errors as temporary - retry with different proxy
                // These accounts don't actually have Steam Guard, it's a Steam API issue
                winston.warn(`${this.username} got Steam Guard error (code ${err.eresult}), will retry with different proxy`);
                this.emit('loginFailed', err, 'steamguard');
            } else if (isProxyError && !isAuthError) {
                // Proxy/network error - try different proxy
                winston.warn(`${this.username} got proxy error: ${errorString}, will retry with different proxy`);
                this.emit('loginFailed', err, 'proxy');
            } else if (isRateLimitError) {
                // Rate limit - retry with same proxy after delay
                winston.warn(`${this.username} hit rate limit, will retry after delay`);
                this.emit('loginFailed', err, 'ratelimit');
            } else if (isAuthError) {
                // Password wrong or other auth issue - don't retry
                winston.error(`${this.username} has authentication error, will not retry`);
                this.emit('authFailed', err);
            } else {
                // Unknown error - log it but don't retry
                winston.error(`${this.username} got uncategorized error: ${errorString}`);
            }
        });

        this.steamClient.on('disconnected', (eresult, msg) => {
            winston.warn(`${this.username} Logged off, reconnecting! (${eresult}, ${msg})`);
        });

        this.steamClient.on('loggedOn', (details, parental) => {
            winston.info(`${this.username} Log on OK`);
            
            // Emit login success event for proxy pool manager tracking
            this.emit('loginSuccess');

            // Fixes reconnecting to CS:GO GC since node-steam-user still assumes we're playing 730
            // and never sends the appLaunched event to node-globaloffensive
            this.steamClient.gamesPlayed([], true);

            if (this.relogin) {
                // Don't check ownership cache since the event isn't always emitted on relogin
                winston.info(`${this.username} Initiating GC Connection, Relogin`);
                this.steamClient.gamesPlayed([730], true);
                return;
            }

            // Ensure we own CSGO
            // We have to wait until app ownership is cached to safely check
            this.steamClient.once('ownershipCached', () => {
                if (!this.steamClient.ownsApp(730)) {
                    winston.info(`${this.username} doesn't own CS:GO, retrieving free license`);

                    // Request a license for CS:GO
                    this.steamClient.requestFreeLicense([730], (err, grantedPackages, grantedAppIDs) => {
                        winston.debug(`${this.username} Granted Packages`, grantedPackages);
                        winston.debug(`${this.username} Granted App IDs`, grantedAppIDs);

                        if (err) {
                            winston.error(`${this.username} Failed to obtain free CS:GO license`);
                        } else {
                            winston.info(`${this.username} Initiating GC Connection`);
                            this.steamClient.gamesPlayed([730], true);
                        }
                    });
                } else {
                    winston.info(`${this.username} Initiating GC Connection`);
                    this.steamClient.gamesPlayed([730], true);
                }
            });
        });

        this.csgoClient.on('inspectItemInfo', (itemData) => {
            if (this.resolve && this.currentRequest) {
                itemData = {iteminfo: itemData};

                // Ensure the received itemid is the same as what we want
                if (itemData.iteminfo.itemid !== this.currentRequest.a) return;

                // Clear any TTL timeout
                if (this.ttlTimeout) {
                    clearTimeout(this.ttlTimeout);
                    this.ttlTimeout = false;
                }

                // GC requires a delay between subsequent requests
                // Figure out how long to delay until this bot isn't busy anymore
                let offset = new Date().getTime() - this.currentRequest.time;
                let delay = this.settings.request_delay - offset;

                // If we're past the request delay, don't delay
                if (delay < 0) delay = 0;

                itemData.delay = delay;
                itemData.iteminfo.s = this.currentRequest.s;
                itemData.iteminfo.a = this.currentRequest.a;
                itemData.iteminfo.d = this.currentRequest.d;
                itemData.iteminfo.m = this.currentRequest.m;

                // If the paintseed is 0, the proto returns null, force 0
                itemData.iteminfo.paintseed = itemData.iteminfo.paintseed || 0;

                // paintwear -> floatvalue to match previous API version response
                itemData.iteminfo.floatvalue = itemData.iteminfo.paintwear;
                delete itemData.iteminfo.paintwear;

                // Backwards compatibility with previous node-globaloffensive versions
                for (const sticker of itemData.iteminfo.stickers) {
                    sticker.stickerId = sticker.sticker_id;
                    delete sticker.sticker_id;
                }

                this.resolve(itemData);
                this.resolve = false;
                this.currentRequest = false;

                setTimeout(() => {
                    // We're no longer busy (satisfied request delay)
                    this.busy = false;
                }, delay);
            }
        });

        this.csgoClient.on('connectedToGC', () => {
            winston.info(`${this.username} CSGO Client Ready!`);

            this.ready = true;
        });

        this.csgoClient.on('disconnectedFromGC', (reason) => {
            winston.warn(`${this.username} CSGO unready (${reason}), trying to reconnect!`);
            this.ready = false;

            // node-globaloffensive will automatically try to reconnect
        });

        this.csgoClient.on('connectionStatus', (status) => {
            winston.debug(`${this.username} GC Connection Status Update ${status}`);
        });

        this.csgoClient.on('debug', (msg) => {
            winston.debug(msg);
        });

        this.csgoClient.on('inspectItemTimedOut', () => {
            if (this.resolve && this.currentRequest) {
                winston.warn(`${this.username} Inspect request timed out for asset ${this.currentRequest.a}`);
                
                // Clear the TTL timeout
                if (this.ttlTimeout) {
                    clearTimeout(this.ttlTimeout);
                    this.ttlTimeout = false;
                }
                
                // Store the reject function before clearing
                const rejectFn = this.reject;
                
                // Mark as not busy and clear current request
                this.busy = false;
                this.currentRequest = false;
                this.resolve = false;
                this.reject = false;
                
                // Reject the promise with timeout error
                if (rejectFn) {
                    rejectFn('GC inspect timeout');
                }
            }
        });
    }

    sendFloatRequest(link) {
        return new Promise((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
            this.busy = true;

            const params = link.getParams();
            winston.debug(`${this.username} Fetching for ${params.a}`);

            this.currentRequest = {s: params.s, a: params.a, d: params.d, m: params.m, time: new Date().getTime()};

            if (!this.ready) {
                reject('This bot is not ready');
            }
            else {
                // The first param (owner) depends on the type of inspect link
                this.csgoClient.inspectItem(params.s !== '0' ? params.s : params.m, params.a, params.d);
            }

            // Set a timeout in case the GC takes too long to respond
            this.ttlTimeout = setTimeout(() => {
                // GC didn't respond in time, reset and reject
                this.busy = false;
                this.currentRequest = false;
                reject('ttl exceeded');
            }, this.settings.request_ttl);
        });
    }

    updateProxySettings(proxyUrl) {
        winston.debug(`Updating proxy settings for ${this.username}`);
        
        if (!this.settings.steam_user) {
            this.settings.steam_user = {};
        }
        
        // Clear old proxy settings
        delete this.settings.steam_user.httpProxy;
        delete this.settings.steam_user.socksProxy;
        
        // Set new proxy
        if (proxyUrl) {
            if (proxyUrl.startsWith('http://')) {
                this.settings.steam_user.httpProxy = proxyUrl;
            } else if (proxyUrl.startsWith('socks5://')) {
                this.settings.steam_user.socksProxy = proxyUrl;
            }
        }
        
        // Recreate Steam client with new settings
        if (this.steamClient) {
            this.steamClient.logOff();
            this.steamClient = new SteamUser(Object.assign({
                promptSteamGuardCode: false,
                enablePicsCache: true
            }, this.settings.steam_user));
            
            // Rebind event handlers
            this.bindEventHandlers();
            
            // Update CS:GO client
            this.csgoClient = new GlobalOffensive(this.steamClient);
        }
    }
}

module.exports = Bot;
