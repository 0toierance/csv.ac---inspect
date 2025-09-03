const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Default configuration
const defaultConfig = {
    directory: './logs',
    level: 'debug',
    maxFileSize: 20 * 1024 * 1024, // 20MB
    maxFiles: 5,
    consoleOutput: true,
    fileOutput: true
};

// Create logger instance
function createLogger(config = {}) {
    const logConfig = Object.assign({}, defaultConfig, config);
    
    // Ensure log directory exists
    const logDir = path.resolve(logConfig.directory);
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }
    
    // Create transports array
    const transports = [];
    
    // Console transport
    if (logConfig.consoleOutput) {
        transports.push(new winston.transports.Console({
            level: logConfig.level,
            colorize: true,
            timestamp: true,
            handleExceptions: true,
            humanReadableUnhandledException: true
        }));
    }
    
    // File transports
    if (logConfig.fileOutput) {
        // Combined log file
        transports.push(new winston.transports.File({
            name: 'combined-file',
            level: logConfig.level,
            filename: path.join(logDir, 'combined.log'),
            maxsize: logConfig.maxFileSize,
            maxFiles: logConfig.maxFiles,
            timestamp: true,
            json: false,
            handleExceptions: true,
            humanReadableUnhandledException: true,
            formatter: function(options) {
                const timestamp = new Date().toISOString();
                const level = options.level.toUpperCase();
                const message = options.message || '';
                const meta = (options.meta && Object.keys(options.meta).length) 
                    ? '\n\t' + JSON.stringify(options.meta) 
                    : '';
                return `${timestamp} [${level}] ${message}${meta}`;
            }
        }));
        
        // Error log file
        transports.push(new winston.transports.File({
            name: 'error-file',
            level: 'error',
            filename: path.join(logDir, 'error.log'),
            maxsize: logConfig.maxFileSize,
            maxFiles: logConfig.maxFiles,
            timestamp: true,
            json: false,
            handleExceptions: true,
            humanReadableUnhandledException: true,
            formatter: function(options) {
                const timestamp = new Date().toISOString();
                const level = options.level.toUpperCase();
                const message = options.message || '';
                const meta = (options.meta && Object.keys(options.meta).length) 
                    ? '\n\t' + JSON.stringify(options.meta) 
                    : '';
                return `${timestamp} [${level}] ${message}${meta}`;
            }
        }));
        
        // Debug log file (if debug level is enabled)
        if (logConfig.level === 'debug') {
            transports.push(new winston.transports.File({
                name: 'debug-file',
                level: 'debug',
                filename: path.join(logDir, 'debug.log'),
                maxsize: logConfig.maxFileSize,
                maxFiles: logConfig.maxFiles,
                timestamp: true,
                json: false,
                formatter: function(options) {
                    const timestamp = new Date().toISOString();
                    const level = options.level.toUpperCase();
                    const message = options.message || '';
                    const meta = (options.meta && Object.keys(options.meta).length) 
                        ? '\n\t' + JSON.stringify(options.meta) 
                        : '';
                    return `${timestamp} [${level}] ${message}${meta}`;
                }
            }));
        }
    }
    
    // Create and configure logger
    const logger = new winston.Logger({
        level: logConfig.level,
        transports: transports,
        exitOnError: false
    });
    
    // Add stream for morgan HTTP logging if needed
    logger.stream = {
        write: function(message, encoding) {
            logger.info(message.trim());
        }
    };
    
    // Log initialization
    logger.info('===========================================');
    logger.info('Logger initialized with configuration:');
    logger.info(`  Log Level: ${logConfig.level}`);
    logger.info(`  Log Directory: ${logDir}`);
    logger.info(`  Console Output: ${logConfig.consoleOutput}`);
    logger.info(`  File Output: ${logConfig.fileOutput}`);
    logger.info(`  Max File Size: ${logConfig.maxFileSize} bytes`);
    logger.info(`  Max Files: ${logConfig.maxFiles}`);
    logger.info('===========================================');
    
    return logger;
}

module.exports = createLogger;