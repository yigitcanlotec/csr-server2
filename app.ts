import express, { text } from 'express';
import { Pool, QueryResult } from 'pg';
import crypto from 'crypto';
import cors from 'cors';
import bcrypt = require("bcrypt");


const app = express();
const port = 3000;

app.use(cors({credentials: true,  origin: ['http://localhost:5500', 'http://127.0.0.1:5500']}));
app.use(express.json());

function generateRandomString(length: number) {
  const buffer = crypto.randomBytes(length);
  return buffer.toString('hex');
}



function argumentString(argument: string, startIndex: number) {
  const [ps, ...args] = process.argv;
  if (
      typeof argument &&
      args.find((element) => element.includes(argument)) !== undefined
  ) {
      return args
          .find((element) => element.includes(argument))
          .substring(startIndex);
  } else {
      return undefined;
  }
}

const pool = new Pool({
  user: argumentString('--user=', 7) || 'postgres',
  host: argumentString('--host=', 7) || 'localhost',
  database: argumentString('--database=', 11) || 'todo_app',
  password: argumentString('--password=', 11) || 'pass123',
  port: parseInt(argumentString('--port=', 7)) || 5432,
});


const isAuthenticated = (req, res, next) =>{
 
  if (req.headers.authorization){
    const userToken = req.headers.authorization.split(' ')[1];
    const queryString = `SELECT * FROM userdb WHERE (session_key = $1);`;
    pool.query(queryString, [userToken]).then((result) => {
      if (result.rowCount === 1){
        next();
      } else {
        res.sendStatus(401);
      }
    })
  } else {
    res.sendStatus(400);
  }
  
}



app.get('/api/v1/login', async (req, res) => {
  let queryString = "SELECT * FROM userdb WHERE (username = $1);";
  const userCredentials = atob(req.headers.authorization.split(' ')[1]).split(':');
  const isUserExists = (await pool.query(queryString, [userCredentials[0]]))
  if (isUserExists.rowCount){
    if (isUserExists.rows[0].username === userCredentials[0]){
      const isPasswordSame = await bcrypt.compare(userCredentials[1], isUserExists.rows[0].password);
      if (isPasswordSame){
        const randStr = generateRandomString(16);
        queryString = `UPDATE userdb SET session_key=$1 WHERE (username = $2);`;
        await pool.query(queryString, [randStr, userCredentials[0]]);
        res.status(200).send(randStr);
        return;
      }
    }
  } 
    res.sendStatus(401);
});


app.post('/api/v1/register', async (req, res, next) => {
  const queryString = 'INSERT INTO userdb(username, password) VALUES($1,$2);'
  const hashedPassword = await bcrypt.hash(req.body.password, 10);
 
  pool.query(queryString, [req.body.username, hashedPassword]).then((result) => {
    return res.sendStatus(200);
  }).catch((error) => {
    return res.sendStatus(400);
  })
  
});

app.get('/api/v1/tasks/', isAuthenticated, async (req, res) => {
    let queryString: string;
    let queryData: Array<QueryResult>;
    // console.log(req.query, req.headers.authorization);
    if (req.query.filter === undefined || req.query.filter === 'all') {
        if (req.headers.authorization){
          // const userIdentity = atob(req.headers.authorization.split(' ')[1]).split(':');
          const userToken = req.headers.authorization.split(' ')[1];
          queryString =  `SELECT username FROM userdb WHERE (session_key = $1);`
          const userName =  (await pool.query(queryString, [userToken])).rows[0].username;
          // console.log(userName);
          queryString = 'SELECT * FROM todo WHERE (assignee = $1) ORDER BY id ASC';
          queryData = (await pool.query(queryString, [userName])).rows;
          return res.status(200).send({queryData: queryData, username: userName});
        } else {
          return res.sendStatus(401);
        }
    } else {
      if (req.headers.authorization){
        // const userIdentity = atob(req.headers.authorization.split(' ')[1]).split(':');
        const userToken = req.headers.authorization.split(' ')[1];
        queryString =  `SELECT username FROM userdb WHERE (session_key = $1);`
        const userName =  (await pool.query(queryString, [userToken])).rows[0].username;
        // console.log(userName);
        queryString = `SELECT * FROM todo WHERE (assignee = $1 AND done=$2) ORDER BY id ASC`;
        queryData = (await pool.query(queryString, [userName, req.query.filter])).rows;
        return res.status(200).send({queryData: queryData, username: userName});
      } else {
        return res.sendStatus(401);
      }
    }
});



app.get('/api/v1/:user/:userId', isAuthenticated ,async (req, res) => {
  const queryString = `SELECT * FROM todo WHERE (assignee = $1 AND id = $2});`;
  const queryData = (await pool.query(queryString, [req.params.user, req.params.userId])).rows;
  res.status(200).send(queryData);

})

app.post('/api/v1/tasks/insert', isAuthenticated, async (req, res) => {
  const formData = req.body;
  let queryString = '';
  const userToken = req.headers.authorization.split(' ')[1];
  queryString =  `SELECT username FROM userdb WHERE (session_key = $1);`
  const userName =  (await pool.query(queryString, [userToken])).rows[0].username;
  // console.log(userName);
  queryString = `INSERT INTO todo (title, assignee, done) values ($1,$2,$3);`;
  await pool.query(queryString, [ formData.title, userName, formData.done ]);

  res.sendStatus(200);

});


app.post('/api/v1/task/:taskId/delete', isAuthenticated,  async (req, res) => {
  const formData = req.body;
  // console.log(formData);

      const queryString = 'DELETE FROM todo WHERE (id = $1 AND assignee = $2);';
      await pool.query(queryString, [req.params.taskId , req.body.assignee]);

      res.sendStatus(200);
  
});

app.post('/api/v1/task/:taskId/done', isAuthenticated, async (req, res) => {
  const queryString = `UPDATE todo 
                          SET
                              done=true 
                          WHERE (id = $1 AND assignee = $2);`;
  await pool.query(queryString, [req.params.taskId, req.body.assignee]);
  res.sendStatus(200);
});

app.post('/api/v1/task/:taskId/undone', async (req, res) => {
  const queryString = `UPDATE todo 
                            SET
                                done=false 
                            WHERE (id = $1 AND assignee = $2);`;
  await pool.query(queryString, [req.params.taskId, req.body.assignee]);
  res.sendStatus(200);
});


app.post('/api/v1/task/:taskId/delete', async (req, res) => {
  const queryString = `DELETE FROM todo WHERE (id = $1 AND assignee = $2);`;
  await pool.query(queryString, [req.params.taskId, req.body.assignee]);
  res.sendStatus(200);
});


app.post('/api/v1/task/:taskId/update', (req, res) => {
    // console.log(req.body);
    const queryString = `UPDATE todo 
    SET
        title=$1,
        done=$2 
    WHERE (id = $3 AND assignee = $4);`;


  pool
  .query(queryString, [req.body.title, req.body.done, req.body.id, req.body.assignee ])
  .then((queryResult) => {
    // console.log(queryResult);
    res.sendStatus(200);
  })
  .catch((err) => {
  res.send(err);
  });
})

app.get('/api/v1/userInfo', isAuthenticated, async (req, res) =>{
  const queryString =  `SELECT (username, password) FROM userdb WHERE (session_key = $1);`;
  const userToken = req.headers.authorization.split(' ')[1];
  const queryData = (await pool.query(queryString, [userToken])).rows[0];
  const credentials = queryData.row.substring(1, queryData.row.length-1).split(',');

    res.status(200).send(credentials);
});

app.listen(port, () => {
  return console.log(`Express is listening at http://localhost:${port}`);
});
