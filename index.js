#!/usr/bin/env node

const os = require('os');
const MQTT = require('mqtt');

const LOGGING_LEVELS = {
  FATAL: 0,
  ERROR: 1,
  DEBUG: 3,
  INFO: 2
};

let Thingy = null;

const BROKER_STATE_READY = 'ready';
const BROKER_STATE_CONNECTING = 'connecting';
const BROKER_STATE_CONNECTED = 'connected';
const APP_STATE_RUNNING = 'running';
const APP_STATE_STOPPING = 'stopping';
const SEND_GATEWAY_CONNECTED = 'GATEWAY_CONNECTED';
const SEND_DEVICE_CONNECTED = 'DEVICE_CONNECTED';

const BROKER_CONNECT_INTERVAL = 3000;
const DISCOVERY_INTERVAL = 6000;
const DISCOVERY_RESTART_TIMEOUT = 5000; // XXX: Workaround for noble-device issue
const DISCOVER_WITH_FILTER_TIMEOUT = 3000;
const APPLICATION_START_TIMEOUT = 5000; // XXX: Wait HCI devices on system startup

let discoveryTaskId = null;
let dataTransmissionTaskId = null;

let brokerConnectionState = BROKER_STATE_READY;
let applicationState = APP_STATE_RUNNING;

let mqttClient = null;
let connectedThingies = {};
let multiThingyState = {};
let config = {};

// Commons
// ==========

const loadConfig = () => {
  const c = require('./config');
  let { topic } = c.mqtt;
  topic = topic.replace('{hostname}', os.hostname());
  c.mqtt.topic = topic;
  return c;
};

const log = (msg, data = '', level = LOGGING_LEVELS.DEBUG) => {
  const appLoggingLevel = LOGGING_LEVELS[config.app.loggingLevel];
  if (level <= LOGGING_LEVELS.ERROR) {
    console.error(msg, data);
  }
  else if (level <= appLoggingLevel) {
    console.log(`${msg}`, data);
  }
};

// Broker Utils
// ==========

const brokerDisconnect = () => {
  if (mqttClient) {
    mqttClient.end(true);
    mqttClient = null;
  }
};

const brokerConnect = (mqttConfig) => {
  brokerConnectionState = BROKER_STATE_CONNECTING;
  const mqttAddr = `${mqttConfig.host}:${mqttConfig.port}`;
  log(`Connecting to: ${mqttAddr}`);

  const connectionProblemsHandler = (err) => {
    if (err) {
      log('Connection problem, disconnecting ...', err, LOGGING_LEVELS.ERROR);
      brokerDisconnect();
      brokerConnectionState = BROKER_STATE_READY;
    }
  };

  const client = MQTT.connect({
    protocol: 'mqtt',
    host: mqttConfig.host,
    port: mqttConfig.port
  });

  client.on('connect', () => {
    mqttClient = client;
    log(`Successfully connected to: ${mqttAddr}`, '', LOGGING_LEVELS.INFO);
    brokerConnectionState = BROKER_STATE_CONNECTED;
  });
  client.on('close', connectionProblemsHandler);
  client.on('error', connectionProblemsHandler);
  client.on('end', connectionProblemsHandler);
  client.on('offline', connectionProblemsHandler);
};

const startBrokerConnectTask = (appConfig) => {
  log('Start Broker Connect ...');
  if (brokerConnectionState !== BROKER_STATE_CONNECTING
      && brokerConnectionState !== BROKER_STATE_CONNECTED) {
    brokerConnect(appConfig.mqtt);
  }
};

const stopBrokerConnectTask = () => {
  log('Stop Broker ...');
  brokerDisconnect();
};

// Thingy Utils
// ==========

const disconnectThingies = (disconnected) => {
  if (!disconnected) {
    Object.keys(connectedThingies).forEach((id) => {
      connectedThingies[id].disconnect();
    });
  }
  connectedThingies = {};
  multiThingyState = {};
};

const macToId = mac => (mac.toLowerCase().replace(new RegExp(':', 'g'), ''));

const startDiscoverThings = (appConfig) => {
  const handleDiscover = (thingy) => {
    if (!connectedThingies[thingy.id]) {
      connectAndSetupThingy(thingy); // eslint-disable-line no-use-before-define
    }
  };
  log('Discovering Things... already connected thingies:', multiThingyState, LOGGING_LEVELS.INFO);
  Thingy.SCAN_DUPLICATES = true;
  Thingy.startScanning();
  // Thingy.stopScanning();
  appConfig.ble.deviceMACs.forEach((mac) => {
    const id = macToId(mac);
    if (!connectedThingies[id]) {
      log(`Trying to discover device: ${id}`);
      setTimeout(() => {
        Thingy.discoverWithFilter((device) => {
          const result = (id === device.id);
          if (result) {
            log(`Discovered: ${device.id} target: ${id}`, '', LOGGING_LEVELS.INFO);
          }
          return result;
        }, handleDiscover);
      }, DISCOVER_WITH_FILTER_TIMEOUT);
    }
  });
  Thingy.stopScanning();
};

const stopDiscoverThings = () => {
  Thingy.stopDiscoverAll((err) => {
    if (err) {
      log('Connection/Setup problem, disconnecting ...', err, LOGGING_LEVELS.ERROR);
    }
  });
  // disconnectThingies(disconnected);
};

const startDiscoveryRestartTask = () => {
  log('Start Discovery Task ...');
  const appConfig = loadConfig();
  setInterval(() => {
    stopDiscoverThings();
    setTimeout(() => {
      startDiscoverThings(appConfig);
    }, DISCOVERY_RESTART_TIMEOUT);
  }, DISCOVERY_INTERVAL);
};

const stopDiscoveryRestartTask = () => {
  log('Stop Discovery Task ...');
  clearInterval(discoveryTaskId);
};

const connectAndSetupThingy = (thingy) => {
  const handleError = (error) => {
    if (error) {
      log('Connection/Setup problem, disconnecting ...', error, LOGGING_LEVELS.ERROR);
    }
  };

  log('Connecting to the Thingy:52', thingy.id, LOGGING_LEVELS.INFO);
  thingy.connectAndSetUp((error) => {
    if (error) handleError(error);
    else {
      // User Interface
      thingy.led_breathe({
        color: 2,
        intensity: 100,
        delay: 1000
      }, handleError);
      thingy.button_enable(handleError);
      thingy.on('buttonNotif', (state) => {
        if (state === 'Pressed') {
          multiThingyState[thingy.id].button = true;
          multiThingyState[thingy.id].button_number = 1;
        }
      });
      thingy.temperature_enable(handleError);
      thingy.on('temperatureNotif', (temp) => {
        multiThingyState[thingy.id].temperature = temp;
      });
      thingy.humidity_enable(handleError);
      thingy.on('humidityNotif', (hum) => {
        multiThingyState[thingy.id].humidity = hum;
      });
      thingy.pressure_enable(handleError);
      thingy.on('pressureNotif', (pres) => {
        multiThingyState[thingy.id].pressure = pres;
      });
      // Service
      thingy.on('disconnect', () => {
        log(`Thingy disconnected: ${thingy.id}`, LOGGING_LEVELS.INFO);
        delete multiThingyState[thingy.id];
        delete connectedThingies[thingy.id];
      });
      connectedThingies[thingy.id] = thingy;
      multiThingyState[thingy.id] = {
        temperature: 0,
        humidity: 0,
        pressure: 0,
        button: false,
        button_number: 0,
        deviceId: thingy.id
      };
      log('Successfully connected to ', thingy.id, LOGGING_LEVELS.INFO);
    }
  });
};

// Transmission Utils
// ==========

const send = (appConfig, payload, status) => {
  const msg = {
    status,
    ts: new Date().toISOString(),
    gatewayId: appConfig.deviceId,
    deviceId: appConfig.deviceId // this could get overwritten by paylaod below
  };
  if (payload) {
    msg.temperature = payload.temperature;
    msg.humidity = payload.humidity;
    msg.pressure = payload.pressure;
    msg.button = payload.button;
    msg.button_number = payload.button_number;
    msg.deviceId = payload.deviceId;
  }
  const jsonMsg = JSON.stringify(msg);
  mqttClient.publish(appConfig.topic, jsonMsg);
  log(`Publish to ${appConfig.topic} ${jsonMsg}`);
};

const sendDeviceState = (thingy, appConfig) => {
  if (multiThingyState[thingy.id]) {
    send(appConfig, multiThingyState[thingy.id], SEND_DEVICE_CONNECTED);
    multiThingyState[thingy.id].button = false;
    multiThingyState[thingy.id].button_number = 0;
  }
};

const sendHealth = (appConfig) => {
  send(appConfig, null, SEND_GATEWAY_CONNECTED);
};

const startSendingTask = (appConfig) => {
  log('Start Sending Task ...');
  return setInterval(() => {
    if (mqttClient) {
      let sentDeviceState = false;
      Object.keys(connectedThingies).forEach((id) => {
        sendDeviceState(connectedThingies[id], appConfig.mqtt);
        sentDeviceState = true;
      });
      if (!sentDeviceState) {
        sendHealth(appConfig.mqtt);
      }
    }
  }, appConfig.app.sendInterval);
};

const stopSendingTask = () => {
  log('Stop Sending Task ...');
  clearInterval(dataTransmissionTaskId);
};

// App Utils
// ==========

const start = (appConfig) => {
  log('Starting with Config: ', appConfig, LOGGING_LEVELS.INFO);

  startBrokerConnectTask(appConfig);
  startDiscoverThings(appConfig);
  discoveryTaskId = startDiscoveryRestartTask(appConfig);
  dataTransmissionTaskId = startSendingTask(appConfig);
};

const stop = () => {
  if (applicationState === APP_STATE_STOPPING) return;
  applicationState = APP_STATE_STOPPING;
  log('Stopping ...');
  stopSendingTask();
  stopBrokerConnectTask();
  stopDiscoveryRestartTask();
  stopDiscoverThings();
};

const init = () => {
  config = loadConfig();
  log('Initialize ...');
  // Setup noble lib
  process.env.NOBLE_HCI_DEVICE_ID = config.ble.hciDeviceNum;
  Thingy = require('thingy52');
  // Set exit handlers
  process.on('exit', () => {
    stop();
  });
  process.on('uncaughtException', (err) => {
    log('uncaughtException:', err, LOGGING_LEVELS.FATAL);
    try {
      stop();
    }
    catch (stopErr) {
      log('Error while stop:', stopErr, LOGGING_LEVELS.FATAL);
    }
    finally {
      process.exit(-1);
    }
  });
  return config;
};

// Application
// ==========
init();
setTimeout(() => {
  start(config);
}, APPLICATION_START_TIMEOUT);
