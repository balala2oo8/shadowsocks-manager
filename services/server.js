const log4js = require('log4js');
const logger = log4js.getLogger('system');

const knex = appRequire('init/knex').knex;
const crypto = require('crypto');
// const path = require('path');
const config = appRequire('services/config').all();
const password = config.manager.password;
const host = config.manager.address.split(':')[0];
const port = +config.manager.address.split(':')[1];

const shadowsocks = appRequire('services/shadowsocks');

const net = require('net');

const receiveData = (receive, data) => {
  receive.data = Buffer.concat([receive.data, data]);
  checkData(receive);
};

const checkCode = (data, password, code) => {
  const time = Number.parseInt(data.slice(0, 6).toString('hex'), 16);
  if (Math.abs(Date.now() - time) > 10 * 60 * 1000) {
    return false;
  }
  const command = data.slice(6).toString();
  const md5 = crypto.createHash('md5').update(time + command + password).digest('hex');
  return md5.substr(0, 8) === code.toString('hex');
};

const receiveCommand = async (data, code) => {
  try {
    const time = Number.parseInt(data.slice(0, 6).toString('hex'), 16);
    await knex('command').whereBetween('time', [0, Date.now() - 10 * 60 * 1000]).del();
    await knex('command').insert({
      code: code.toString('hex'),
      time,
    });
    const message = JSON.parse(data.slice(6).toString());
    logger.info(message);
    if (message.command === 'add') {
      const port = +message.port;
      const password = message.password;
      return shadowsocks.addAccount(port, password);
    } else if (message.command === 'del') {
      const port = +message.port;
      return shadowsocks.removeAccount(port);
    } else if (message.command === 'list') {
      return shadowsocks.listAccount();
    } else if (message.command === 'pwd') {
      const port = +message.port;
      const password = message.password;
      return shadowsocks.changePassword(port, password);
    } else if (message.command === 'flow') {
      const options = message.options;
      return shadowsocks.getFlow(options);
    } else if (message.command === 'version') {
      return shadowsocks.getVersion();
    } else if (message.command === 'ip') {
      return shadowsocks.getClientIp(message.port);
    } else if (message.command === 'batch_options') {
      const start = new Date();
      var list = message.list || [];
      let ports = (await shadowsocks.listAccount()).map(a => a.port);
      // list.forEach((item, index) => {
      //   if (item.command === 'add') {
      //     const port = +item.port;
      //     const password = item.password;
      //     if (!ports.indexOf(item.port) >= 0) {
      //       shadowsocks.addAccount(port, password);
      //     }
      //   } else if (item.command === 'del') {
      //     const port = +item.port;
      //     if (ports.indexOf(item.port) >= 0) {
      //       shadowsocks.removeAccount(port);
      //     }
      //   }
      // })
      let count = list.length;
      let result = { count }
      console.log(`请求结束，用时：${new Date() - start}ms，结果：${result.toString()}`);
      //return shadowsocks.getVersion();
      return result;
    } else {
      return Promise.reject();
    }
  } catch (err) {
    throw err;
  }
};

const pack = (data) => {
  const message = JSON.stringify(data);
  const dataBuffer = Buffer.from(message);
  const length = dataBuffer.length;
  const lengthBuffer = Buffer.from(('0000' + length.toString(16)).substr(-4), 'hex');
  const pack = Buffer.concat([lengthBuffer, dataBuffer]);
  return pack;
};

const checkData = (receive) => {
  const buffer = receive.data;
  let length = 0;
  let data;
  let code;
  if (buffer.length < 2) {
    return;
  }
  length = buffer[0] * 256 + buffer[1];
  if (buffer.length >= length + 2) {
    data = buffer.slice(2, length - 2);
    code = buffer.slice(length - 2);
    // receive.data = buffer.slice(length + 2, buffer.length);
    if (!checkCode(data, password, code)) {
      console.log('数据校验失败');
      receive.socket.end();
      // receive.socket.close();
      return;
    }
    receiveCommand(data, code).then(s => {
      receive.socket.end(pack({ code: 0, data: s }));
      // receive.socket.close();
    }, e => {
      logger.error(e);
      receive.socket.end(pack({ code: 1 }));
      // receive.socket.close();
    });
    if (buffer.length > length + 2) {
      checkData(receive);
    }
  }
};

const server = net.createServer(socket => {
  const receive = {
    data: Buffer.from(''),
    socket: socket,
  };
  socket.on('data', data => {
    receiveData(receive, data);
  });
  socket.on('end', () => {
    socket.end();
    //客户端连接全部关闭的时候退出引用程序
    server.unref();
  });
  socket.on('close', (has_error) => {
    if (has_error) {
      console.log('由于一个错误导致socket连接被关闭', has_error);
      server.unref();
    }
  });
}).on('error', (err) => {
  logger.error(`socket error: `, err);
  socket.destroy();
});

server.listen({
  port,
  host,
}, () => {
  logger.info(`server listen on ${host}:${port}`);
});