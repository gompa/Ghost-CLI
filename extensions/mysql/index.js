'use strict';

const Promise = require('bluebird');
const mysql = require('mysql');
const omit = require('lodash/omit');
const cli = require('../../lib');
const generator = require('generate-password');

class MySQLExtension extends cli.Extension {
    setup(cmd, argv) {
        // Case 1: ghost install local OR ghost setup --local
        // Case 2: ghost install --db sqlite3
        // Skip in both cases
        if (argv.local || argv.db === 'sqlite3') {
            return;
        }

        cmd.addStage('mysql', this.setupMySQL.bind(this), [], '"ghost" mysql user');
    }

    setupMySQL(argv, ctx, task) {
        const dbconfig = ctx.instance.config.get('database.connection');

        if (dbconfig.user !== 'root') {
            this.ui.log('MySQL user is not "root", skipping additional user setup', 'yellow');
            return task.skip();
        }

        return this.ui.listr([{
            title: 'Connecting to database',
            task: () => this.canConnect(ctx, dbconfig)
        }, {
            title: 'Creating new MySQL user',
            task: () => this.createUser(ctx, dbconfig)
        }, {
            title: 'Granting new user permissions',
            task: () => this.grantPermissions(ctx, dbconfig)
        }, {
            title: 'Saving new config',
            task: () => {
                ctx.instance.config.set('database.connection.user', ctx.mysql.username)
                    .set('database.connection.password', ctx.mysql.password).save();

                this.connection.end();
            }
        }], false);
    }

    canConnect(ctx, dbconfig) {
        this.connection = mysql.createConnection(omit(dbconfig, 'database'));

        return Promise.fromCallback(cb => this.connection.connect(cb)).catch((error) => {
            if (error.code === 'ECONNREFUSED') {
                return Promise.reject(new cli.errors.ConfigError({
                    message: error.message,
                    config: {
                        'database.connection.host': dbconfig.host,
                        'database.connection.port': dbconfig.port || '3306'
                    },
                    environment: this.system.environment,
                    help: 'Please ensure that MySQL is installed and reachable. You can always re-run `ghost setup` to try again.'
                }));
            } else if (error.code === 'ER_ACCESS_DENIED_ERROR') {
                return Promise.reject(new cli.errors.ConfigError({
                    message: error.message,
                    config: {
                        'database.connection.user': dbconfig.user,
                        'database.connection.password': dbconfig.password
                    },
                    environment: this.system.environment,
                    help: 'You can run `ghost config` to re-enter the correct credentials. Alternatively you can run `ghost setup` again.'
                }));
            }

            return Promise.reject(error);
        });
    }

    createUser(ctx, dbconfig) {
        const randomPassword = generator.generate({
            length: 10,
            numbers: true,
            symbols: true,
            strict: true
        });

        // IMPORTANT: we generate random MySQL usernames
        // e.g. you delete all your Ghost instances from your droplet and start from scratch, the MySQL users would remain and the CLI has to generate a random user name to work
        // e.g. if we would rely on the instance name, the instance naming only auto increments if there are existing instances
        // the most important fact is, that if a MySQL user exists, we have no access to the password, which we need to autofill the Ghost config
        // disadvantage: the CLI could potentially create lot's of MySQL users (but this should only happen if the user installs Ghost over and over again with root credentials)
        const username = 'ghost-' + Math.floor(Math.random() * 1000);

        return this._query(`CREATE USER '${username}'@'${dbconfig.host}' IDENTIFIED WITH mysql_native_password;`).then(() => {
            this.ui.logVerbose(`MySQL: successfully created new user ${username}`, 'green');

            return this._query('SET old_passwords = 0;');
        }).then(() => {
            this.ui.logVerbose('MySQL: successfully disabled old_password', 'green');

            return this._query(`SET PASSWORD FOR '${username}'@'${dbconfig.host}' = PASSWORD('${randomPassword}');`);
        }).then(() => {
            this.ui.logVerbose(`MySQL: successfully created password for user ${username}`, 'green');

            ctx.mysql = {
                username: username,
                password: randomPassword
            };
        }).catch((error) => {
            // User already exists, run this method again
            if (error.errno === 1396) {
                this.ui.logVerbose('MySQL: user exists, re-trying user creation with new username', 'yellow');
                return this.createUser(ctx, dbconfig);
            }

            this.ui.logVerbose('MySQL: Unable to create custom Ghost user', 'red');
            this.connection.end(); // Ensure we end the connection
            return Promise.reject(new cli.errors.SystemError(`Creating new mysql user errored with message: ${error.message}`));
        });
    }

    grantPermissions(ctx, dbconfig) {
        return this._query(`GRANT ALL PRIVILEGES ON ${dbconfig.database}.* TO '${ctx.mysql.username}'@'${dbconfig.host}';`).then(() => {
            this.ui.logVerbose(`MySQL: Successfully granted privileges for user "${ctx.mysql.username}"`, 'green');
            return this._query('FLUSH PRIVILEGES;');
        }).then(() => {
            this.ui.logVerbose('MySQL: flushed privileges', 'green');
        }).catch((error) => {
            this.ui.logVerbose('MySQL: Unable either to grant permissions or flush privileges', 'red');
            this.connection.end();
            return Promise.reject(new cli.errors.SystemError(`Granting database permissions errored with message: ${error.message}`));
        });
    }

    _query(queryString) {
        this.ui.logVerbose(`MySQL: running query > ${queryString}`, 'gray');
        return Promise.fromCallback(cb => this.connection.query(queryString, cb));
    }
}

module.exports = MySQLExtension;
