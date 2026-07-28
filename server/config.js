const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '0.0.0.0';

function getPort() {
  const parsedPort = Number(process.env.PORT);
  return Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;
}

function getHost() {
  return process.env.HOST || DEFAULT_HOST;
}

module.exports = {
  DEFAULT_PORT,
  DEFAULT_HOST,
  getPort,
  getHost,
};
