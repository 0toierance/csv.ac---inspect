global._mckay_statistics_opt_out = true; // Opt out of node-steam-user stats

const optionDefinitions = [
    { name: 'config', alias: 'c', type: String, defaultValue: './config.js' }, // Config file location
    { name: 'steam_data', alias: 's', type: String } // Steam data directory
];

const args = require('command-line-args')(optionDefinitions),
    CONFIG = require(args.config),
    createLogger = require('./lib/logger'),
    winston = createLogger(CONFIG.logging || {}),
    bodyParser = require('body-parser'),
    rateLimit = require('express-rate-limit'),
    utils = require('./lib/utils'),
    queue = new (require('./lib/queue'))(),
    InspectURL = require('./lib/inspect_url'),
    botController = new (require('./lib/bot_controller'))(),
    postgres = new (require('./lib/postgres'))(CONFIG.database_url, CONFIG.enable_bulk_inserts),
    gameData = new (require('./lib/game_data'))(CONFIG.game_files_update_interval, CONFIG.enable_game_file_updates),
    errors = require('./errors'),
    Job = require('./lib/job'),
    ProxyPoolManager = require('./lib/proxy_pool_manager');

// Make winston globally available for other modules
global.winston = winston;

if (CONFIG.max_simultaneous_requests === undefined) {
    CONFIG.max_simultaneous_requests = 1;
}

if (CONFIG.logins.length === 0) {
    console.log('There are no bot logins. Please add some in config.json');
    process.exit(1);
}

if (args.steam_data) {
    CONFIG.bot_settings.steam_user.dataDirectory = args.steam_data;
}

// Initialize proxy pool manager if enabled
let proxyPoolManager = null;
if (CONFIG.proxy_pool && CONFIG.proxy_pool.enabled) {
    winston.info('Initializing proxy pool manager...');
    proxyPoolManager = new ProxyPoolManager(
        CONFIG.proxy_pool.file || './proxies_value.txt',
        CONFIG.proxy_pool.max_requests_per_proxy || 3,
        CONFIG.proxy_pool.request_cooldown || 100,
        CONFIG.proxy_pool  // Pass entire proxy_pool config for retry settings
    );
    botController.setProxyPoolManager(proxyPoolManager);
    winston.info(`Proxy pool manager initialized with ${proxyPoolManager.proxyGroups.length} proxies`);
    winston.info(`Login retry: ${CONFIG.proxy_pool.retry_on_login_failure ? 'enabled' : 'disabled'}, max retries: ${CONFIG.proxy_pool.max_login_retries || 3}`);
}

// Group bots for initialization
const allBots = [];

for (let [i, loginData] of CONFIG.logins.entries()) {
    const settings = Object.assign({}, CONFIG.bot_settings);
    allBots.push({ loginData, settings });
}

// Split into initial bots and spare accounts based on max_online_bots config
const maxOnlineBots = CONFIG.max_online_bots || allBots.length;
const botsToInitialize = allBots.slice(0, maxOnlineBots);
const spareAccounts = allBots.slice(maxOnlineBots);

winston.info(`Total accounts: ${allBots.length}, Target online: ${maxOnlineBots}, Spare accounts: ${spareAccounts.length}`);

// Staggered bot startup
async function startBotsStaggered() {
    const delayBetweenWaves = 3000; // 3 seconds between waves
    const chunkSize = 3; // Conservative approach - 3 bots per chunk for safe startup
    
    winston.info(`Starting ${botsToInitialize.length} bots (keeping ${spareAccounts.length} as spares)...`);
    
    if (proxyPoolManager) {
        winston.info(`Using proxy pool with ${proxyPoolManager.proxyGroups.length} proxies`);
    }
    
    let totalBotCount = 0;
    
    // Process bots in chunks
    for (let i = 0; i < botsToInitialize.length; i += chunkSize) {
        const chunk = botsToInitialize.slice(i, i + chunkSize);
        totalBotCount += chunk.length;
        
        winston.info(`Starting ${chunk.length} bots (${totalBotCount}/${botsToInitialize.length} initial bots)`);
        
        // Add bots
        const addedBots = [];
        for (const { loginData, settings } of chunk) {
            const bot = botController.addBot(loginData, settings);
            addedBots.push(bot);
        }
        
        // If using proxy pool, distribute bots after adding them
        if (proxyPoolManager && addedBots.length > 0) {
            proxyPoolManager.distributeBots(botController.bots);
        }
        
        // Wait before starting next chunk
        if (i + chunkSize < botsToInitialize.length) {
            winston.info(`Waiting ${delayBetweenWaves / 1000} seconds before next batch...`);
            await new Promise(resolve => setTimeout(resolve, delayBetweenWaves));
        }
    }
    
    winston.info('All initial bots queued for startup');
    
    // Set spare accounts in bot controller
    if (spareAccounts.length > 0) {
        botController.setSpareAccounts(spareAccounts);
        botController.setMaxOnlineBots(maxOnlineBots);
        
        // Check bot count periodically and add spares if needed
        setInterval(() => {
            botController.checkAndMaintainBotCount();
        }, 30000); // Check every 30 seconds
    }
}

// Start the staggered bot initialization
startBotsStaggered();

postgres.connect();

// Setup and configure express
const app = require('express')();
app.use(function (req, res, next) {
    if (req.method === 'POST') {
        // Default content-type
        req.headers['content-type'] = 'application/json';
    }
    next();
});
app.use(bodyParser.json({limit: '5mb'}));

app.use(function (error, req, res, next) {
    // Handle bodyParser errors
    if (error instanceof SyntaxError) {
        errors.BadBody.respond(res);
    }
    else next();
});


if (CONFIG.trust_proxy === true) {
    app.enable('trust proxy');
}

CONFIG.allowed_regex_origins = CONFIG.allowed_regex_origins || [];
CONFIG.allowed_origins = CONFIG.allowed_origins || [];
const allowedRegexOrigins = CONFIG.allowed_regex_origins.map((origin) => new RegExp(origin));


async function handleJob(job) {
    // See which items have already been cached
    const itemData = await postgres.getItemData(job.getRemainingLinks().map(e => e.link));
    for (let item of itemData) {
        const link = job.getLink(item.a);

        if (!item.price && link.price) {
            postgres.updateItemPrice(item.a, link.price);
        }

        gameData.addAdditionalItemProperties(item);
        item = utils.removeNullValues(item);

        job.setResponse(item.a, item);
    }

    if (!botController.hasBotOnline()) {
        return job.setResponseRemaining(errors.SteamOffline);
    }

    if (CONFIG.max_simultaneous_requests > 0 &&
        (queue.getUserQueuedAmt(job.ip) + job.remainingSize()) > CONFIG.max_simultaneous_requests) {
        return job.setResponseRemaining(errors.MaxRequests);
    }

    if (CONFIG.max_queue_size > 0 && (queue.size() + job.remainingSize()) > CONFIG.max_queue_size) {
        return job.setResponseRemaining(errors.MaxQueueSize);
    }

    if (job.remainingSize() > 0) {
        queue.addJob(job, CONFIG.bot_settings.max_attempts);
    }
}

function canSubmitPrice(key, link, price) {
    return CONFIG.price_key && key === CONFIG.price_key && price && link.isMarketLink() && utils.isOnlyDigits(price);
}

app.use(function (req, res, next) {
    if (CONFIG.allowed_origins.length > 0 && req.get('origin') != undefined) {
        // check to see if its a valid domain
        const allowed = CONFIG.allowed_origins.indexOf(req.get('origin')) > -1 ||
            allowedRegexOrigins.findIndex((reg) => reg.test(req.get('origin'))) > -1;

        if (allowed) {
            res.header('Access-Control-Allow-Origin', req.get('origin'));
            res.header('Access-Control-Allow-Methods', 'GET');
        }
    }
    next()
});

if (CONFIG.rate_limit && CONFIG.rate_limit.enable) {
    app.use(rateLimit({
        windowMs: CONFIG.rate_limit.window_ms,
        max: CONFIG.rate_limit.max,
        headers: false,
        handler: function (req, res) {
            errors.RateLimit.respond(res);
        }
    }))
}

app.get('/', function(req, res) {
    // Get and parse parameters
    let link;

    if ('url' in req.query) {
        link = new InspectURL(req.query.url);
    }
    else if ('a' in req.query && 'd' in req.query && ('s' in req.query || 'm' in req.query)) {
        link = new InspectURL(req.query);
    }

    if (!link || !link.getParams()) {
        return errors.InvalidInspect.respond(res);
    }

    const job = new Job(req, res, /* bulk */ false);

    let price;

    if (canSubmitPrice(req.query.priceKey, link, req.query.price)) {
        price = parseInt(req.query.price);
    }

    job.add(link, price);

    try {
        handleJob(job);
    } catch (e) {
        winston.warn(e);
        errors.GenericBad.respond(res);
    }
});

app.post('/bulk', (req, res) => {
    if (!req.body || (CONFIG.bulk_key && req.body.bulk_key != CONFIG.bulk_key)) {
        return errors.BadSecret.respond(res);
    }

    if (!req.body.links || req.body.links.length === 0) {
        return errors.BadBody.respond(res);
    }

    if (CONFIG.max_simultaneous_requests > 0 && req.body.links.length > CONFIG.max_simultaneous_requests) {
        return errors.MaxRequests.respond(res);
    }

    const job = new Job(req, res, /* bulk */ true);

    for (const data of req.body.links) {
        const link = new InspectURL(data.link);
        if (!link.valid) {
            return errors.InvalidInspect.respond(res);
        }

        let price;

        if (canSubmitPrice(req.body.priceKey, link, data.price)) {
            price = parseInt(req.query.price);
        }

        job.add(link, price);
    }

    try {
        handleJob(job);
    } catch (e) {
        winston.warn(e);
        errors.GenericBad.respond(res);
    }
});

app.get('/stats', (req, res) => {
    const stats = {
        bots_online: botController.getReadyAmount(),
        bots_total: botController.bots.length,
        queue_size: queue.queue.length,
        queue_concurrency: queue.concurrency,
        pending_auth: botController.getPendingAuthBots().length
    };
    
    // Add proxy pool stats if available
    if (proxyPoolManager) {
        stats.proxy_pool = proxyPoolManager.getStats();
    }
    
    // Add pending auth details if any
    const pendingAuthBots = botController.getPendingAuthBots();
    if (pendingAuthBots.length > 0) {
        stats.pending_auth_details = pendingAuthBots;
    }
    
    res.json(stats);
});

// Endpoint to provide Steam Guard code for a bot
app.post('/auth', (req, res) => {
    if (!req.body || !req.body.username || !req.body.code) {
        return res.status(400).json({ error: 'Username and code required' });
    }
    
    // Optional: Add auth key for security
    if (CONFIG.auth_key && req.body.auth_key !== CONFIG.auth_key) {
        return res.status(403).json({ error: 'Invalid auth key' });
    }
    
    const success = botController.retryBotWithAuthCode(req.body.username, req.body.code);
    
    if (success) {
        res.json({ 
            success: true, 
            message: `Retrying bot ${req.body.username} with provided code`,
            pending_auth_remaining: botController.getPendingAuthBots().length
        });
    } else {
        res.status(404).json({ 
            error: `Bot ${req.body.username} not found in pending auth queue`,
            pending_auth_bots: botController.getPendingAuthBots().map(b => b.username)
        });
    }
});

// Endpoint to list bots waiting for Steam Guard
app.get('/pending-auth', (req, res) => {
    const pendingBots = botController.getPendingAuthBots();
    res.json({
        count: pendingBots.length,
        bots: pendingBots
    });
});

// Status monitoring endpoint
app.get('/status', (req, res) => {
    const status = botController.getBotStatus();
    res.json({
        ...status,
        message: `${status.online}/${status.target} bots online`,
        health: status.status,
        details: {
            online_bots: status.online,
            target_bots: status.target,
            total_bots: status.total,
            busy_bots: status.busy,
            failed_accounts: status.failed,
            spare_accounts_remaining: status.spares,
            pending_steam_guard: status.pendingAuth
        }
    });
});

const http_server = require('http').Server(app);
http_server.listen(CONFIG.http.port);
winston.info('Listening for HTTP on port: ' + CONFIG.http.port);

queue.process(CONFIG.logins.length, botController, async (job) => {
    const itemData = await botController.lookupFloat(job.data.link);
    winston.debug(`Received itemData for ${job.data.link.getParams().a}`);

    // Save and remove the delay attribute
    let delay = itemData.delay;
    delete itemData.delay;

    // add the item info to the DB
    await postgres.insertItemData(itemData.iteminfo, job.data.price);

    // Get rank, annotate with game files
    itemData.iteminfo = Object.assign(itemData.iteminfo, await postgres.getItemRank(itemData.iteminfo.a));
    gameData.addAdditionalItemProperties(itemData.iteminfo);

    itemData.iteminfo = utils.removeNullValues(itemData.iteminfo);
    itemData.iteminfo.stickers = itemData.iteminfo.stickers.map((s) => utils.removeNullValues(s));
    itemData.iteminfo.keychains = itemData.iteminfo.keychains.map((s) => utils.removeNullValues(s));

    job.data.job.setResponse(job.data.link.getParams().a, itemData.iteminfo);

    return delay;
});

queue.on('job failed', (job, err) => {
    const params = job.data.link.getParams();
    winston.warn(`Job Failed! S: ${params.s} A: ${params.a} D: ${params.d} M: ${params.m} IP: ${job.ip}, Err: ${(err || '').toString()}`);

    job.data.job.setResponse(params.a, errors.TTLExceeded);
});
