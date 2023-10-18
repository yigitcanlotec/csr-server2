import express, { text } from 'express';
import { Pool, QueryResult } from 'pg';
import crypto from 'crypto';
import cors from 'cors';
import bcrypt = require('bcrypt');
import 'dotenv/config'
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand  } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { rateLimit } from 'express-rate-limit';

const app = express();


const limiter = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 minutes
	limit: 100, // Limit each IP to 100 requests per `window` (here, per 15 minutes)
	standardHeaders: 'draft-7', // draft-6: `RateLimit-*` headers; draft-7: combined `RateLimit` header
	legacyHeaders: false, // Disable the `X-RateLimit-*` headers
	// store: ... , // Use an external store for more precise rate limiting
});


app.use(
    cors({
        credentials: true,
        origin: process.env.ORIGIN,
    })
);
app.use(express.json());
app.use(rateLimit);

// Generate API key for session (token).
function generateRandomString(length: number) {
    const buffer = crypto.randomBytes(length);
    return buffer.toString('hex');
}

// Parsing console command argument.
function consoleInputArgumentParser(argument: string, startIndex: number) {
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
    user: consoleInputArgumentParser('--user=', 7) || 'postgres',
    host: consoleInputArgumentParser('--host=', 7) || 'localhost',
    database: consoleInputArgumentParser('--database=', 11) || 'todo_app',
    password: consoleInputArgumentParser('--password=', 11) || 'pass123',
    port: parseInt(consoleInputArgumentParser('--port=', 7)) || 5432,
});

// Middleware for user authorization.
const isAuthenticated = (req, res, next) => {
    if (req.headers.authorization) {
        const userToken = req.headers.authorization.split(' ')[1];
        const queryString = `SELECT * FROM userdb WHERE (session_key = $1);`;
        pool.query(queryString, [userToken]).then((result) => {
            if (result.rowCount === 1) {
                next();
            } else {
                res.sendStatus(401);
            }
        });
    } else {
        res.sendStatus(400);
    }
};

app.get('/api/login', async (req, res) => {
    let queryString = 'SELECT * FROM userdb WHERE (username = $1);';
    const userCredentials = atob(req.headers.authorization.split(' ')[1]).split(
        ':'
    );
    const isUserExists = await pool.query(queryString, [userCredentials[0]]);
    if (isUserExists.rowCount) {
        if (isUserExists.rows[0].username === userCredentials[0]) {
            const isPasswordSame = await bcrypt.compare(
                userCredentials[1],
                isUserExists.rows[0].password
            );
            if (isPasswordSame) {
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

app.post('/api/register', async (req, res, next) => {
    const queryString = 'INSERT INTO userdb(username, password) VALUES($1,$2);';
    const hashedPassword = await bcrypt.hash(req.body.password, 10);
 
    pool.query(queryString, [req.body.username, hashedPassword])
        .then((result) => {
            return res.sendStatus(200);
        })
        .catch((error) => {
            return res.sendStatus(400);
        });
});


app.get('/api/:user/:userId', isAuthenticated, async (req, res) => {
  const queryString = `SELECT * FROM todo WHERE (assignee = $1 AND id = $2});`;
  const queryData = (
    await pool.query(queryString, [req.params.user, req.params.userId])
    ).rows;
    res.status(200).send(queryData);
  });
  
app.get('/api/tasks', isAuthenticated, async (req, res) => {
    let queryString: string;
    let queryData: Array<QueryResult>;

    if (req.query.filter === undefined || req.query.filter === 'all') {
        if (req.headers.authorization) {
            const userToken = req.headers.authorization.split(' ')[1];
            queryString = `SELECT username FROM userdb WHERE (session_key = $1);`;
            const userName = (await pool.query(queryString, [userToken]))
                .rows[0].username;

            queryString =
                'SELECT * FROM todo WHERE (assignee = $1) ORDER BY id ASC';
            queryData = (await pool.query(queryString, [userName])).rows;
            return res
                .status(200)
                .send({ queryData: queryData, username: userName });
        } else {
            return res.sendStatus(401);
        }
    } else {
        if (req.headers.authorization) {
            const userToken = req.headers.authorization.split(' ')[1];
            queryString = `SELECT username FROM userdb WHERE (session_key = $1);`;
            const userName = (await pool.query(queryString, [userToken]))
                .rows[0].username;
            queryString = `SELECT * FROM todo WHERE (assignee = $1 AND done=$2) ORDER BY id ASC`;
            queryData = (
                await pool.query(queryString, [userName, req.query.filter])
            ).rows;
            return res
                .status(200)
                .send({ queryData: queryData, username: userName });
        } else {
            return res.sendStatus(401);
        }
    }
});
  
app.get('/api/:user/tasks/image', isAuthenticated, async (req, res) => {

  const s3Client = new S3Client({
    region: process.env.REGION,
    credentials: {
      accessKeyId: process.env.ACCESS_KEY_ID,
      secretAccessKey: process.env.SECRET_ACCESS_KEY,
    }
  });

  let command = new ListObjectsV2Command({
    Bucket: process.env.BUCKET_NAME,
    Prefix: req.params.user + '/' 
  });


  const response = await s3Client.send(command);
  // console.log(response);

  if (response.Contents){
   
      const files = response.Contents.map(object => object.Key);
   
    
    const promises = files.map(async (file) => {
      return getSignedUrl(s3Client, new GetObjectCommand({
        Bucket: process.env.BUCKET_NAME,
        Key: file
      }), { expiresIn: 60 });
    });
    
    Promise.all(promises)
      .then((results) => {
        const fileLinkArray = results;
        const mapping = {};


        files.forEach((key, index) => {
          mapping[key] = fileLinkArray[index];
        });
        res.status(200).send(mapping);
        // You can use fileLinkArray here or send it as a response, etc.
      })
      .catch((error) => {
        console.error(error);
        res.sendStatus(500);
        // Handle errors here
      });
  
    
  } else {
    res.sendStatus(204);
  }
  

});

app.post('/api/task/insert/image', isAuthenticated, async (req, res) => {

  const s3Client = new S3Client({
    region: process.env.REGION,
    credentials: {
      accessKeyId: process.env.ACCESS_KEY_ID,
      secretAccessKey: process.env.SECRET_ACCESS_KEY,
    }
  });

  const command = new PutObjectCommand({
    Bucket: process.env.BUCKET_NAME,
    Key: req.body.fileName
  });

  const url = await getSignedUrl(s3Client, command, { expiresIn: 60 });
 
  res.send(url);

});

app.post('/api/task/insert', isAuthenticated, async (req, res) => {
    const formData = req.body;
    let queryString = '';
    const userToken = req.headers.authorization.split(' ')[1];
    queryString = `SELECT username FROM userdb WHERE (session_key = $1);`;
    const userName = (await pool.query(queryString, [userToken])).rows[0]
        .username;
    queryString = `INSERT INTO todo (id, title, assignee, done) values ($1,$2,$3,$4);`;
    await pool.query(queryString, [formData.id,formData.title, userName, formData.done]);

    res.sendStatus(200);
});

app.post('/api/task/:taskId/delete', isAuthenticated, async (req, res) => {
    const queryString = 'DELETE FROM todo WHERE (id = $1 AND assignee = $2);';
    await pool.query(queryString, [req.params.taskId, req.body.assignee]);
    const s3Client = new S3Client({
      region: process.env.REGION,
      credentials: {
        accessKeyId: process.env.ACCESS_KEY_ID,
        secretAccessKey: process.env.SECRET_ACCESS_KEY,
      }
    });
    const params = {
      Bucket: process.env.BUCKET_NAME,
      Key: req.body.assignee + '/' + req.params.taskId
    };

    try {
      // List objects within the folder
      const listParams = {
        Bucket: process.env.BUCKET_NAME,
        Prefix: req.body.assignee + '/' + req.params.taskId,
      };
      const data = await s3Client.send(new ListObjectsV2Command(listParams));
  
      // Delete each object within the folder
      const deletePromises = data.Contents.map(async (object) => {
        const deleteParams = {
          Bucket: process.env.BUCKET_NAME,
          Key: object.Key,
        };
        await s3Client.send(new DeleteObjectCommand(deleteParams));
        // console.log(`Object deleted successfully: ${object.Key}`);
      });
  
      // Wait for all delete operations to complete
      await Promise.all(deletePromises);
  
      // Delete the folder itself (prefix)
      const deleteFolderParams = {
        Bucket: process.env.BUCKET_NAME,
        Key: req.body.assignee + '/' + req.params.taskId,
      };
      await s3Client.send(new DeleteObjectCommand(deleteFolderParams));
      // console.log(`Folder deleted successfully: ${req.body.assignee + '/' + req.params.taskId}`);
    } catch (error) {
      // console.error('Error deleting folder:', error);
    }
    res.sendStatus(200);
});

app.post('/api/task/:taskId/done', isAuthenticated, async (req, res) => {
    const queryString = `UPDATE todo 
                          SET
                              done=true 
                          WHERE (id = $1 AND assignee = $2);`;
    await pool.query(queryString, [req.params.taskId, req.body.assignee]);
    res.sendStatus(200);
});

app.post('/api/task/:taskId/undone', async (req, res) => {
    const queryString = `UPDATE todo 
                            SET
                                done=false 
                            WHERE (id = $1 AND assignee = $2);`;
    await pool.query(queryString, [req.params.taskId, req.body.assignee]);
    res.sendStatus(200);
});

app.post('/api/task/:taskId/delete', async (req, res) => {
    const queryString = `DELETE FROM todo WHERE (id = $1 AND assignee = $2);`;
    await pool.query(queryString, [req.params.taskId, req.body.assignee]);
    res.sendStatus(200);
});

app.post('/api/task/:taskId/update', (req, res) => {
    const queryString = `UPDATE todo 
    SET
        title=$1,
        done=$2 
    WHERE (id = $3 AND assignee = $4);`;

    pool.query(queryString, [
        req.body.title,
        req.body.done,
        req.body.id,
        req.body.assignee,
    ])
        .then((queryResult) => {
            res.sendStatus(200);
        })
        .catch((err) => {
            res.send(err);
        });
});

app.get('/api/userInfo', isAuthenticated, async (req, res) => {
    const queryString = `SELECT (username, password) FROM userdb WHERE (session_key = $1);`;
    const userToken = req.headers.authorization.split(' ')[1];
    const queryData = (await pool.query(queryString, [userToken])).rows[0];
    const credentials = queryData.row
        .substring(1, queryData.row.length - 1)
        .split(',');

    res.status(200).send(credentials);
});

app.listen(process.env.PORT , () => {
    return console.log(`Express is listening at http://localhost:${process.env.PORT}`);
});
