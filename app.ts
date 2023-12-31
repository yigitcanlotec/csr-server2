import express, { NextFunction, Request, Response } from 'express';
import pkg from 'pg';
const { Pool } = pkg;
import { QueryResult } from 'pg';
import crypto from 'crypto';
import cors from 'cors';
import bcrypt from 'bcrypt';
import 'dotenv/config'
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand, ListObjectsV2CommandOutput, ListObjectsV2CommandInput, DeleteObjectCommandInput  } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { rateLimit } from 'express-rate-limit';
import morgan from 'morgan';
import { exec } from 'child_process';
import os from 'os';


const app = express();


const limiter = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 minutes
	limit: 100, // Limit each IP to 100 requests per `window` (here, per 15 minutes)
	standardHeaders: 'draft-7', // draft-6: `RateLimit-*` headers; draft-7: combined `RateLimit` header
	legacyHeaders: false, // Disable the `X-RateLimit-*` headers
	// store: ... , // Use an external store for more precise rate limiting
});


app.use(cors());
app.use(express.json());
app.use(morgan('dev'));
// app.use(rateLimit);

// Middleware to handle invalid requests and send a 404 status error
// app.use((req, res, next) => {
//     res.status(404).send('Not Found');
//   });
  

// Generate API key for session (token).
function generateRandomString(length: number) {
    const buffer = crypto.randomBytes(length);
    return buffer.toString('hex');
}


const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'todo_app',
    password: process.env.DB_PASSWORD || 'pass123',
    port: parseInt(process.env.DB_PORT) || 5432,
    ssl: {
      rejectUnauthorized:false
    }
});

// Middleware for user authorization.
const isAuthenticated = (req: Request, res: Response, next: NextFunction): any => {
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




app.get('/api/login', async (req: Request, res: Response): Promise<any> => {
    let queryString: string = 'SELECT * FROM userdb WHERE (username = $1);';
    const userCredentials: string[] = atob(req.headers.authorization.split(' ')[1]).split(':');
    if (!userCredentials) return res.sendStatus(401);
    const isUserExists: QueryResult = await pool.query(queryString, [userCredentials[0]]);
    if (isUserExists.rowCount) {
        if (isUserExists.rows[0].username === userCredentials[0]) {
            const isPasswordSame: boolean = await bcrypt.compare(
                userCredentials[1],
                isUserExists.rows[0].password
            );
            if (isPasswordSame) {
                const randStr: string = generateRandomString(16);
                queryString = `UPDATE userdb SET session_key=$1 WHERE (username = $2);`;
                await pool.query(queryString, [randStr, userCredentials[0]]);
                return res.status(200).send(randStr);

            }
        }
    }
    return res.sendStatus(401);
});

app.post('/api/register', async (req: Request, res: Response): Promise<void> => {
  const queryString: string = 'INSERT INTO userdb(username, password) VALUES($1, $2);';
  const hashedPassword: string = await bcrypt.hash(req.body.password, 10);

  try {
      await pool.query(queryString, [req.body.username, hashedPassword]);
      res.sendStatus(200);
  } catch (error) {
      console.error(error);
      res.sendStatus(400);
  }
});


app.get('/api/:user/:userId', isAuthenticated, async (req: Request, res: Response): Promise<void>  => {
  const queryString: string = `SELECT * FROM todo WHERE (assignee = $1 AND id = $2});`;
  const queryData: string[] = (
    await pool.query(queryString, [req.params.user, req.params.userId])
    ).rows;
    res.status(200).send(queryData);
  });
  
app.get('/api/tasks', isAuthenticated, async (req: Request, res: Response) => {
    let queryString: string;
    let queryData: Array<QueryResult>;

    if (req.query.filter === undefined || req.query.filter === 'all') {
        if (req.headers.authorization) {
            const userToken: string = req.headers.authorization.split(' ')[1];
            queryString = `SELECT username FROM userdb WHERE (session_key = $1);`;
            const userName: string = (await pool.query(queryString, [userToken])).rows[0].username;

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
            const userToken: string = req.headers.authorization.split(' ')[1];
            queryString = `SELECT username FROM userdb WHERE (session_key = $1);`;
            const userName: QueryResult = (await pool.query(queryString, [userToken]))
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
  
app.get('/api/:user/tasks/image', isAuthenticated, async (req: Request, res: Response) => {

  const s3Client: S3Client = new S3Client({
    region: process.env.REGION,
    credentials: {
      accessKeyId: process.env.ACCESS_KEY_ID,
      secretAccessKey: process.env.SECRET_ACCESS_KEY,
    }
  });

  let command: ListObjectsV2Command = new ListObjectsV2Command({
    Bucket: process.env.BUCKET_NAME,
    Prefix: req.params.user + '/' 
  });


  const response: ListObjectsV2CommandOutput = await s3Client.send(command);
  // console.log(response);

  if (response.Contents){
   
      const files: string[] = response.Contents.map(object => object.Key);
   
    
    const promises = files.map(async (file) => {
      return getSignedUrl(s3Client, new GetObjectCommand({
        Bucket: process.env.BUCKET_NAME,
        Key: file
      }), { expiresIn: 60 });
    });
    
    Promise.all(promises)
      .then((results) => {
        const fileLinkArray: string[] = results;
        const mapping: Object = {};


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

app.post('/api/task/insert/image', isAuthenticated, async (req: Request, res: Response) => {

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

app.post('/api/task/insert', isAuthenticated, async (req: Request, res: Response) => {
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

app.post('/api/task/:taskId/delete', isAuthenticated, async (req: Request, res: Response) => {
    const queryString: string = 'DELETE FROM todo WHERE (id = $1 AND assignee = $2);';
    await pool.query(queryString, [req.params.taskId, req.body.assignee]);
    const s3Client = new S3Client({
      region: process.env.REGION,
      credentials: {
        accessKeyId: process.env.ACCESS_KEY_ID,
        secretAccessKey: process.env.SECRET_ACCESS_KEY,
      }
    });
    const params: object = {
      Bucket: process.env.BUCKET_NAME,
      Key: req.body.assignee + '/' + req.params.taskId
    };

    try {
      // List objects within the folder
      const listParams: ListObjectsV2CommandInput = {
        Bucket: process.env.BUCKET_NAME,
        Prefix: req.body.assignee + '/' + req.params.taskId,
      };
      const data = await s3Client.send(new ListObjectsV2Command(listParams));
  
      // Delete each object within the folder
      const deletePromises: any = data.Contents.map(async (object) => {
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
      const deleteFolderParams: DeleteObjectCommandInput = {
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

app.post('/api/task/:taskId/done', isAuthenticated, async (req: Request, res: Response) => {
    const queryString: string = `UPDATE todo 
                          SET
                              done=true 
                          WHERE (id = $1 AND assignee = $2);`;
    await pool.query(queryString, [req.params.taskId, req.body.assignee]);
    res.sendStatus(200);
});

app.post('/api/task/:taskId/undone', async (req: Request, res: Response) => {
    const queryString: string = `UPDATE todo 
                            SET
                                done=false 
                            WHERE (id = $1 AND assignee = $2);`;
    await pool.query(queryString, [req.params.taskId, req.body.assignee]);
    res.sendStatus(200);
});

app.post('/api/task/:taskId/delete', async (req: Request, res: Response) => {
    const queryString = `DELETE FROM todo WHERE (id = $1 AND assignee = $2);`;
    await pool.query(queryString, [req.params.taskId, req.body.assignee]);
    res.sendStatus(200);
});

app.post('/api/task/:taskId/update', (req: Request, res: Response) => {
    const queryString: string = `UPDATE todo 
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

app.get('/api/userInfo', isAuthenticated, async (req: Request, res: Response) => {
    const queryString: string = `SELECT (username, password) FROM userdb WHERE (session_key = $1);`;
    const userToken: string = req.headers.authorization.split(' ')[1];
    const queryData: any = (await pool.query(queryString, [userToken])).rows[0];
    const credentials: string[] = queryData.row
        .substring(1, queryData.row.length - 1)
        .split(',');

    res.status(200).send(credentials);
});

app.listen(process.env.PORT || 3000, () :any => {
    if (os.type() === 'Linux'){
        exec("hostname -I", (error, stdout, stderr) => {
            if (error) {
              console.error(`Error executing command: ${error.message}`);
              return;
            }
            if (stderr) {
              console.error(`Command execution resulted in an error: ${stderr}`);
              return;
            }
            // console.log(`Command output: ${stdout}`);
            console.log(`Express is listening at http://${stdout}:${process.env.PORT}`);
          });
          return;
    }
    return console.log(`Express is listening at http://localhost:${process.env.PORT}`);;
});
