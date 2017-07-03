#!/usr/bin/env node --harmony
/**
 * Created by igorgo on 02.07.2017.
 */
const
    inquirer = require('inquirer'),
    oracledb = require('oracledb'),
    conU = require('log-update'),
    program = require('commander'),
    xpath = require('xpath'),
    dom = require('xmldom').DOMParser,
    tomlify = require('tomlify-j0.4'),
    fs = require('fs-extra')
let oci
oracledb.maxRows = 10000
oracledb.fetchAsBuffer = [oracledb.BLOB]
oracledb.fetchAsString = [oracledb.CLOB]
oracledb.outFormat = oracledb.OBJECT // {outFormat : oracledb.ARRAY}

const fixNum = (a) => {
    return a ? a.toFixed(0) : null
}

function coalesce(...values) {
    for (let i = 0; i < values.length; i++) {
        if (values[i] !== null && values[i] !== undefined) {
            return values[i];
        }
    }
    return null;
}

const main = async () => {
    let params = await askParams()
    oci = await connectDB(params.username, params.password, params.dbname)
    let z = await exportClass(params.singleClass, params.directory)
    return await closeConnection()
}

const exportClass = async (classCode, dir) => {
    const getClassRn = async (classCode) => {
        conU('... get regno of class')
        let r = await oci.execute(
            `select RN from UNITLIST where UNITCODE = :CLASSCODE`, [classCode]
        )
        if (r.rows.length > 0) {
            return r.rows[0].RN
        }
        else {
            //Promise.reject(new Error('Class not found', 1))
            throw 'Class not found'
        }
    }
    const createDomainsTable = async () => {
        const getMetaDomainList = async () => {
            conU('... get list of metadata\'s domains')
            let r = await oci.execute(`
                select CODE
                  from DMSDOMAINS
                 where RN in (select DOMAIN
                                from DMSCLATTRS
                               where PRN = :CLASSRN
                              union
                              select DOMAIN
                                from DMSCLACTIONSPRM T, UNITFUNC F
                               where F.PRN = :CLASSRN
                                 and T.PRN = F.RN
                              union
                              select DOMAIN
                                from DMSCLMETPARMS T, DMSCLMETHODS M
                               where M.PRN = :CLASSRN
                                 and T.PRN = M.RN
                              union
                              select DOMAIN
                                from DMSCLVIEWSPARAMS T, DMSCLVIEWS V
                               where V.PRN = :CLASSRN
                                 and T.PRN = V.RN)
               `,
                [classRn]
            )
            return r.rows.map((row) => {
                return row.CODE
            })
        }
        const getCondDomainList = async () => {
            conU('... get list of conditions\'s domains')
            let r = await oci.execute(`
                select settings as SETS
                  from UNIT_SHOWMETHODS
                 where PRN = :CLASSRN
                   and LENGTH(SETTINGS) > 0
               `,
                [classRn]
            )
            let res = []
            for (let i = 0; i < r.rows.length; i++) {
                let doc = new dom().parseFromString(r.rows[i].SETS)
                let nodes = xpath.select('/ShowMethod/Group/DataSource/Params/ConditionParams/Param/@Domain', doc)
                nodeVals = nodes.map((node) => {
                    return node.value
                })
                res = res.concat(nodeVals)
            }
            return res
        }
        let domainsMeta = await getMetaDomainList()
        let domainsCond = await getCondDomainList()
        let domains = [...new Set(domainsMeta.concat(domainsCond))].sort()
        let domainsData = []
        for (let i = 0; i < domains.length; i++) {
            let r = await oci.execute(`
                 select D.RN,
                        D.CODE,
                        DT.DATATYPE_TEXT,
                        DT.DATATYPE_SUBTEXT,
                        D.DATA_LENGTH,
                        D.DATA_PRECISION,
                        D.DATA_SCALE,
                        D.DEFAULT_STR,
                        D.DEFAULT_NUM,
                        D.DEFAULT_DATE,
                        D.ENUMERATED,
                        D.PADDING
                   from DMSDOMAINS D, V_DATATYPES DT
                  where D.CODE = :DOMAINCODE
                    and D.DATA_TYPE = DT.DATATYPE_NUMB
                    and D.DATA_SUBTYPE = DT.DATATYPE_SUBNUMB            
            `, [domains[i]])
            let dmn = r.rows[0]
            let name = await getResources(dmn.RN, 'DMSDOMAINS', 'NAME')
            objDomain = {
                'Мнемокод': dmn.CODE,
                'Наименование (RU)': name.RU,
                'Наименование (UK)': name.UK,
                'Тип данных': dmn.DATATYPE_TEXT,
                'Подтип данных': dmn.DATATYPE_SUBTEXT,
                'Размер строки': dmn.DATA_LENGTH,
                'Точность данных': dmn.DATA_PRECISION,
                'Дробность данных': dmn.DATA_SCALE,
                'Значение по умолчанию': coalesce(dmn.DEFAULT_STR, dmn.DEFAULT_NUM, dmn.DEFAULT_DATE),
                'Выравнивать по длине': !!dmn.PADDING,
                'Имеет перечисляемые значения': !!dmn.ENUMERATED,
            }
            if (!!dmn.ENUMERATED) {
                let enumRows = await oci.execute(`
                    select RN,
                           POSITION,
                           VALUE_STR,
                           VALUE_NUM,
                           VALUE_DATE
                      from DMSENUMVALUES T
                     where PRN = :PRN
                     order by POSITION                
                `, [dmn.RN])
                let enumsData = []
                for (let i = 0; i < enumRows.rows.length; i++) {
                    let enumRow = enumRows.rows[i]
                    let enumName = await getResources(enumRow.RN, 'DMSENUMVALUES', 'NAME')
                    objEnum = {
                        'Позиция': enumRow.POSITION.trim(),
                        'Значение': coalesce(enumRow.VALUE_STR, enumRow.VALUE_NUM, enumRow.VALUE_DATE),
                        'Наименование (RU)': enumName.RU,
                        'Наименование (UK)': enumName.UK,
                    }
                    enumsData.push(objEnum)
                }
                objDomain['Перечисляемые значения'] = {
                    'Перечисляемое значение': enumsData
                }
            }
            domainsData.push(objDomain)
        }
        let table = {
            'Используемые домены': {
                'Домен': domainsData
            }
        }
        return table
    }


    conE(`Processing class ${classCode}...`)
    let classRn = await getClassRn(classCode)
    let domainTable = await createDomainsTable()
    // console.log(tomlify(domainTable, null, 4))
    let classDir = dir + '\\' + classCode
    fs.ensureDirSync(classDir)
    await fs.writeFile(classDir+'\\Metadata.toml',tomlify(domainTable, null, 4))
    conE('  ...done')
}


const getResources = async (rn, tab, col) => {
    let res = {
        RU: null,
        UK: null
    }

    let r = await oci.execute(`
        select RESOURCE_LANG,
               RESOURCE_TEXT
          from RESOURCES
         where TABLE_NAME = :ATAB
           and RESOURCE_NAME = :ACOL
           and TABLE_ROW = :ANRN
    `, {
        ATAB: tab,
        ACOL: col,
        ANRN: rn
    })
    for (let i = 0, len = r.rows.length; i < r.rows.length; i++) {
        if (r.rows[i].RESOURCE_LANG == 'RUSSIAN') res.RU = (r.rows[i].RESOURCE_TEXT)
        if (r.rows[i].RESOURCE_LANG == 'UKRAINIAN') res.UA = (r.rows[i].RESOURCE_TEXT)
    }
    return res
}

const con = (m) => {
    process.stdout.write(m);
}

const conE = (m) => {
    process.stdout.write(m + '\n');
}

const askParams = async () => {
    let params = {}
    program
        .arguments('<class>')
        .option('-b, --dbname <dbname>', 'The database alias from tnsnames.ora')
        .option('-u, --username <username>', 'The user to authenticate as')
        .option('-p, --password <password>', 'The user\'s password')
        .option('-d, --directory <directory>', 'The directory to save metadata')
        .parse(process.argv);
    params.dbname = program.dbname || (await inquirer.prompt({
            type: 'input',
            message: 'The database alias from tnsnames.ora:',
            name: 'dbname'
        })).dbname
    params.username = program.username || (await inquirer.prompt({
            type: 'input',
            message: 'The user to connect with database:',
            name: 'username'
        })).username
    params.password = program.password || (await inquirer.prompt({
            type: 'password',
            message: 'The user\'s password:',
            name: 'password'
        })).password
    params.directory = program.directory || (await inquirer.prompt({
            type: 'input',
            message: 'The directory to save metadata:',
            name: 'directory'
        })).directory
    if (program.args.length === 0) {
        // todo: ask for several classes
        program.help();
    } else {
        params.singleClass = program.args[0]
    }
    return params
}

const connectDB = async (dbUser, dbPass, dbName) => {
    con('Connecting to the database…')
    let connect = await oracledb.getConnection({
        user: dbUser,
        password: dbPass,
        connectString: dbName
    })
    conE(' connected!')
    return connect
}

const closeConnection = async () => {
    con('Closing db connection... ')
    let c = await oci.close()
    conE('closed.')
    return c
}

main()
    .then(() => {
        process.exit(0)
    })
    .catch((e) => {
        conE(e)
        closeConnection()
        process.exit(1)
    })

