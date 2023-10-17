import express, { text } from 'express';
import { Pool, QueryResult } from 'pg';
import crypto from 'crypto';
import cors from 'cors';


const app = express();
const port = 3000;

app.use(cors());
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


app.get('/api/v1/tasks/', async (req, res) => {
    let queryString: string;
    let queryData: Array<QueryResult>;

    if (req.query.filter === undefined || req.query.filter === 'all') {
        queryString = 'SELECT * FROM todo ORDER BY id ASC';
        queryData = (await pool.query(queryString)).rows;
        // res.status(200).send(queryData);
    } else {
        queryString = `SELECT * FROM todo WHERE (done=${req.query.filter}) ORDER BY id ASC`;
        queryData = (await pool.query(queryString)).rows;
        // res.status(200).send(queryData);
    }

  res.status(200).send(queryData);
});


app.get('/api/v1/user/:userId', async (req, res) => {
  const queryString = `SELECT * FROM todo WHERE (id = ${req.params.userId})`;
  const queryData = (await pool.query(queryString)).rows;
  res.status(200).send(queryData);

})

app.post('/api/v1/tasks/insert', async (req, res) => {
  const formData = req.body;
  console.log(formData);

      const queryString = `INSERT INTO todo (title, assignee, done) values ('${
          formData.title
      }', '${formData.assignee}', 
      ${
        formData.done
      })`;
      await pool.query(queryString);

      res.sendStatus(200);
  
});


app.post('/api/v1/task/:taskId/delete', async (req, res) => {
  const formData = req.body;
  console.log(formData);

      const queryString = 'DELETE FROM todo WHERE id = $1';
      await pool.query(queryString, [req.params.taskId]);

      res.sendStatus(200);
  
});

app.post('/api/v1/task/:taskId/done', async (req, res) => {
    const formData = req.body;
    
  
    const queryString = `UPDATE todo 
                            SET
                                done=true 
                            WHERE (id = ${req.params.taskId})`;
    await pool.query(queryString);
    res.sendStatus(200);
});

app.post('/api/v1/task/:taskId/undone', async (req, res) => {
  const formData = req.body;
  

  const queryString = `UPDATE todo 
                          SET
                              done=false 
                          WHERE (id = ${req.params.taskId})`;
  await pool.query(queryString);
  res.sendStatus(200);
});


app.post('/api/v1/task/:taskId/delete', async (req, res) => {
  const queryString = `DELETE FROM todo WHERE (id = ${req.params.taskId})`;
  await pool.query(queryString);
  res.sendStatus(200);
});


app.post('/api/v1/task/:taskId/update',async (req, res) => {
    const queryString = `UPDATE todo 
    SET
        title='${req.body.title}',
        done=${req.body.done} 
    WHERE (id = ${req.params.taskId})`;
  pool
  .query(queryString)
  .then(() => {
    res.send(200);
  })
  .catch((err) => {
  res.send(err);
  });
})

app.listen(port, () => {
  return console.log(`Express is listening at http://localhost:${port}`);
});
